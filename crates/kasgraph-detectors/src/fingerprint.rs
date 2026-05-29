//! Compiled-script fingerprint engine.
//!
//! A fingerprint pins the canonical bytes of a covenant's compiled
//! redeem script, with byte ranges (`masked_windows`) that vary per
//! instance — owner pubkey, paused flag, remaining allowance, etc.
//!
//! Matching ignores the masked bytes; extraction returns them as a
//! `BTreeMap<field_name, bytes>` keyed on the window's stable
//! `field` label. Field labels are the contract between detector
//! authors and downstream subgraph handlers.

use std::collections::BTreeMap;

/// A byte range inside a compiled script that varies per instance.
///
/// `field` is the public name surfaced in detector payloads. It must
/// be stable across versions — subgraph handlers key on it.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct MaskedWindow {
    pub field: &'static str,
    pub offset: usize,
    pub len: usize,
}

/// The canonical compiled-script bytes for one pattern, with
/// per-instance state windows masked out.
#[derive(Debug, Clone)]
pub struct Fingerprint {
    /// The canonical script. Bytes inside `masked_windows` are
    /// placeholders that should match anything.
    pub bytes: Vec<u8>,
    pub masked_windows: Vec<MaskedWindow>,
}

impl Fingerprint {
    /// True if `script` matches this fingerprint: same length and
    /// every byte outside the masked windows is equal.
    pub fn matches(&self, script: &[u8]) -> bool {
        if script.len() != self.bytes.len() {
            return false;
        }
        for (i, (&expected, &actual)) in self.bytes.iter().zip(script.iter()).enumerate() {
            if self.in_mask(i) {
                continue;
            }
            if expected != actual {
                return false;
            }
        }
        true
    }

    /// Pull each masked window out of `script` as raw bytes, keyed on
    /// the window's `field` name. Returns `None` if the script does
    /// not match.
    pub fn match_and_extract(&self, script: &[u8]) -> Option<BTreeMap<&'static str, Vec<u8>>> {
        if !self.matches(script) {
            return None;
        }
        let mut out = BTreeMap::new();
        for w in &self.masked_windows {
            let slice = &script[w.offset..w.offset + w.len];
            out.insert(w.field, slice.to_vec());
        }
        Some(out)
    }

    fn in_mask(&self, byte_index: usize) -> bool {
        self.masked_windows
            .iter()
            .any(|w| byte_index >= w.offset && byte_index < w.offset + w.len)
    }

    /// Sanity check: panics if any masked window extends past the
    /// canonical bytes or overlaps another window. Registry entries
    /// call this at module-load time via the tests.
    pub fn validate(&self) -> Result<(), FingerprintError> {
        for w in &self.masked_windows {
            if w.offset + w.len > self.bytes.len() {
                return Err(FingerprintError::WindowOutOfBounds {
                    field: w.field,
                    offset: w.offset,
                    len: w.len,
                    script_len: self.bytes.len(),
                });
            }
        }
        for (i, a) in self.masked_windows.iter().enumerate() {
            for b in &self.masked_windows[i + 1..] {
                let a_end = a.offset + a.len;
                let b_end = b.offset + b.len;
                if a.offset < b_end && b.offset < a_end {
                    return Err(FingerprintError::WindowsOverlap {
                        a: a.field,
                        b: b.field,
                    });
                }
            }
        }
        Ok(())
    }
}

/// A fingerprint for a covenant whose compiled script has a **variable-length
/// middle**. SilverScript unrolls loops into the redeem script, so a
/// contract's loop-bound constructor params (e.g. KCC20's `maxCovIns` /
/// `maxCovOuts`) rewrite the body wholesale — the same pattern compiles to
/// 2728 bytes at one bound and 5104 at another. A whole-script [`Fingerprint`]
/// can't match across those, so this anchors only on the parts that survive:
/// a stable `head` prefix and `tail` suffix, ignoring everything between.
///
/// Per-instance state lives in the head (its offset is bound-independent), so
/// masked windows are head-relative and extraction reads from the head. Use
/// [`Fingerprint`] for fixed-size patterns; use this for loop-parameterized
/// ones. The head/tail must be chosen long enough to be pattern-distinguishing
/// (the shared SilverScript scaffold across patterns is only ~34 head bytes).
#[derive(Debug, Clone)]
pub struct AnchoredFingerprint {
    /// Stable leading bytes. Bytes inside `head_masked_windows` match anything.
    pub head: Vec<u8>,
    /// Per-instance state windows, offset relative to the start of `head`.
    pub head_masked_windows: Vec<MaskedWindow>,
    /// Stable trailing bytes, matched against the end of the script.
    pub tail: Vec<u8>,
}

impl AnchoredFingerprint {
    /// True if `script` begins with `head` (masked bytes wildcarded) and ends
    /// with `tail`, with room for both not to overlap. The middle — the
    /// loop-unrolled body — is unconstrained, so the same pattern matches at
    /// any loop-bound setting.
    pub fn matches(&self, script: &[u8]) -> bool {
        if script.len() < self.head.len() + self.tail.len() {
            return false;
        }
        for (i, &expected) in self.head.iter().enumerate() {
            if self.in_head_mask(i) {
                continue;
            }
            if script[i] != expected {
                return false;
            }
        }
        let tail_start = script.len() - self.tail.len();
        for (j, &expected) in self.tail.iter().enumerate() {
            if script[tail_start + j] != expected {
                return false;
            }
        }
        true
    }

    /// Pull each head-relative masked window out of `script`, keyed on its
    /// `field` name. `None` if the script does not match.
    pub fn match_and_extract(&self, script: &[u8]) -> Option<BTreeMap<&'static str, Vec<u8>>> {
        if !self.matches(script) {
            return None;
        }
        let mut out = BTreeMap::new();
        for w in &self.head_masked_windows {
            out.insert(w.field, script[w.offset..w.offset + w.len].to_vec());
        }
        Some(out)
    }

    fn in_head_mask(&self, byte_index: usize) -> bool {
        self.head_masked_windows
            .iter()
            .any(|w| byte_index >= w.offset && byte_index < w.offset + w.len)
    }

    /// Panics-free validation: every masked window must lie within `head` and
    /// not overlap another. (Windows are head-relative; the tail carries no
    /// state.)
    pub fn validate(&self) -> Result<(), FingerprintError> {
        for w in &self.head_masked_windows {
            if w.offset + w.len > self.head.len() {
                return Err(FingerprintError::WindowOutOfBounds {
                    field: w.field,
                    offset: w.offset,
                    len: w.len,
                    script_len: self.head.len(),
                });
            }
        }
        for (i, a) in self.head_masked_windows.iter().enumerate() {
            for b in &self.head_masked_windows[i + 1..] {
                let a_end = a.offset + a.len;
                let b_end = b.offset + b.len;
                if a.offset < b_end && b.offset < a_end {
                    return Err(FingerprintError::WindowsOverlap {
                        a: a.field,
                        b: b.field,
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum FingerprintError {
    #[error("masked window {field} (offset {offset}, len {len}) extends past script of length {script_len}")]
    WindowOutOfBounds {
        field: &'static str,
        offset: usize,
        len: usize,
        script_len: usize,
    },
    #[error("masked windows {a} and {b} overlap")]
    WindowsOverlap { a: &'static str, b: &'static str },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp() -> Fingerprint {
        // [PREFIX(4)] [OWNER(3)] [INFIX(2)] [STATE(2)] [SUFFIX(3)]
        Fingerprint {
            bytes: vec![
                0x01, 0x02, 0x03, 0x04, // prefix
                0x00, 0x00, 0x00, // owner mask
                0x10, 0x11, // infix
                0x00, 0x00, // state mask
                0x20, 0x21, 0x22, // suffix
            ],
            masked_windows: vec![
                MaskedWindow {
                    field: "owner",
                    offset: 4,
                    len: 3,
                },
                MaskedWindow {
                    field: "state",
                    offset: 9,
                    len: 2,
                },
            ],
        }
    }

    #[test]
    fn matches_exact_canonical_bytes() {
        let f = fp();
        assert!(f.matches(&f.bytes.clone()));
    }

    #[test]
    fn matches_when_masked_bytes_differ() {
        let f = fp();
        let mut script = f.bytes.clone();
        script[4] = 0xAA;
        script[5] = 0xBB;
        script[6] = 0xCC;
        script[9] = 0xDE;
        script[10] = 0xAD;
        assert!(f.matches(&script));
    }

    #[test]
    fn rejects_when_fixed_byte_differs() {
        let f = fp();
        let mut script = f.bytes.clone();
        script[0] = 0xFF; // prefix byte
        assert!(!f.matches(&script));
        let mut script = f.bytes.clone();
        script[8] = 0xFF; // infix byte
        assert!(!f.matches(&script));
        let mut script = f.bytes.clone();
        script[13] = 0xFF; // suffix byte
        assert!(!f.matches(&script));
    }

    #[test]
    fn rejects_on_length_mismatch() {
        let f = fp();
        assert!(!f.matches(&f.bytes[..f.bytes.len() - 1]));
        let mut longer = f.bytes.clone();
        longer.push(0x00);
        assert!(!f.matches(&longer));
    }

    #[test]
    fn extract_returns_window_bytes_by_field() {
        let f = fp();
        let mut script = f.bytes.clone();
        script[4] = 0xAA;
        script[5] = 0xBB;
        script[6] = 0xCC;
        script[9] = 0xDE;
        script[10] = 0xAD;
        let out = f.match_and_extract(&script).expect("matches");
        assert_eq!(out.get("owner"), Some(&vec![0xAA, 0xBB, 0xCC]));
        assert_eq!(out.get("state"), Some(&vec![0xDE, 0xAD]));
    }

    #[test]
    fn extract_returns_none_when_script_does_not_match() {
        let f = fp();
        let mut script = f.bytes.clone();
        script[0] = 0xFF;
        assert!(f.match_and_extract(&script).is_none());
    }

    #[test]
    fn validate_rejects_out_of_bounds_window() {
        let f = Fingerprint {
            bytes: vec![0x00; 4],
            masked_windows: vec![MaskedWindow {
                field: "x",
                offset: 2,
                len: 5,
            }],
        };
        assert!(f.validate().is_err());
    }

    #[test]
    fn validate_rejects_overlapping_windows() {
        let f = Fingerprint {
            bytes: vec![0x00; 16],
            masked_windows: vec![
                MaskedWindow {
                    field: "a",
                    offset: 0,
                    len: 5,
                },
                MaskedWindow {
                    field: "b",
                    offset: 3,
                    len: 5,
                },
            ],
        };
        assert!(f.validate().is_err());
    }

    #[test]
    fn validate_accepts_adjacent_non_overlapping_windows() {
        let f = Fingerprint {
            bytes: vec![0x00; 16],
            masked_windows: vec![
                MaskedWindow {
                    field: "a",
                    offset: 0,
                    len: 5,
                },
                MaskedWindow {
                    field: "b",
                    offset: 5,
                    len: 5,
                },
            ],
        };
        assert!(f.validate().is_ok());
    }

    fn anchored() -> AnchoredFingerprint {
        // head: [H0 H1] [STATE(2)] [H4 H5]   tail: [T0 T1 T2]
        AnchoredFingerprint {
            head: vec![0x01, 0x02, 0x00, 0x00, 0x04, 0x05],
            head_masked_windows: vec![MaskedWindow {
                field: "state",
                offset: 2,
                len: 2,
            }],
            tail: vec![0xF0, 0xF1, 0xF2],
        }
    }

    fn script_with_middle(a: &AnchoredFingerprint, middle: &[u8], state: [u8; 2]) -> Vec<u8> {
        let mut s = a.head.clone();
        s[2] = state[0];
        s[3] = state[1];
        s.extend_from_slice(middle);
        s.extend_from_slice(&a.tail);
        s
    }

    #[test]
    fn anchored_matches_regardless_of_middle_length() {
        let a = anchored();
        // The variable, loop-unrolled middle does not affect matching.
        assert!(a.matches(&script_with_middle(&a, &[], [0xAA, 0xBB])));
        assert!(a.matches(&script_with_middle(&a, &[0x99; 1], [0xAA, 0xBB])));
        assert!(a.matches(&script_with_middle(&a, &[0x99; 4000], [0xAA, 0xBB])));
    }

    #[test]
    fn anchored_rejects_wrong_head_or_tail_fixed_bytes() {
        let a = anchored();
        let mut bad_head = script_with_middle(&a, &[0x99; 8], [0xAA, 0xBB]);
        bad_head[0] = 0xFF; // fixed head byte
        assert!(!a.matches(&bad_head));
        let mut bad_tail = script_with_middle(&a, &[0x99; 8], [0xAA, 0xBB]);
        let n = bad_tail.len();
        bad_tail[n - 1] = 0xFF; // fixed tail byte
        assert!(!a.matches(&bad_tail));
    }

    #[test]
    fn anchored_rejects_script_too_short_for_head_plus_tail() {
        let a = anchored();
        // 6-byte head + 3-byte tail need >= 9 bytes; 8 must not match (and the
        // head/tail must not be allowed to overlap into a false positive).
        assert!(!a.matches(&[0x01, 0x02, 0x00, 0x00, 0x04, 0x05, 0xF0, 0xF1]));
    }

    #[test]
    fn anchored_extracts_head_state_independent_of_middle() {
        let a = anchored();
        let s = script_with_middle(&a, &[0x99; 4000], [0xDE, 0xAD]);
        let out = a.match_and_extract(&s).expect("matches");
        assert_eq!(out.get("state"), Some(&vec![0xDE, 0xAD]));
        // A different middle yields the identical extraction.
        let s2 = script_with_middle(&a, &[0x42; 7], [0xDE, 0xAD]);
        assert_eq!(
            a.match_and_extract(&s2).unwrap().get("state"),
            Some(&vec![0xDE, 0xAD])
        );
    }

    #[test]
    fn anchored_validate_rejects_window_past_head_and_overlap() {
        let past = AnchoredFingerprint {
            head: vec![0x00; 4],
            head_masked_windows: vec![MaskedWindow {
                field: "x",
                offset: 2,
                len: 5,
            }],
            tail: vec![0x00],
        };
        assert!(past.validate().is_err());
        let overlap = AnchoredFingerprint {
            head: vec![0x00; 16],
            head_masked_windows: vec![
                MaskedWindow {
                    field: "a",
                    offset: 0,
                    len: 5,
                },
                MaskedWindow {
                    field: "b",
                    offset: 3,
                    len: 5,
                },
            ],
            tail: vec![0x00],
        };
        assert!(overlap.validate().is_err());
    }
}
