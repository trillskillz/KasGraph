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
}
