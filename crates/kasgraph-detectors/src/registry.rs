//! Pattern registry — the list of fingerprints `detect_in_output`
//! walks.
//!
//! Real OpenSilver compiled-script bytes wire in here. The shape of
//! each entry (prefix discriminator + masked state windows + suffix)
//! is final; the byte contents are placeholders until the OpenSilver
//! manifest pipeline emits the `compiledScriptBytes` field this
//! crate will consume.
//!
//! Each placeholder uses a unique two-byte discriminator
//! (`0xFE, 0x<n>`) so synthetic patterns never collide with each
//! other. Once real bytes land, the discriminator becomes whatever
//! the actual compiled-script prefix is.

use std::sync::OnceLock;

use crate::fingerprint::{Fingerprint, MaskedWindow};
use crate::DetectorKind;

/// One entry in the detector registry.
#[derive(Debug, Clone)]
pub struct DetectorEntry {
    pub kind: DetectorKind,
    pub fingerprint: Fingerprint,
}

/// All known patterns, in detection-priority order. Entries earlier
/// in the list win precedence if `DetectedPattern` consumers want a
/// single canonical match.
pub fn all() -> &'static [DetectorEntry] {
    static REGISTRY: OnceLock<Vec<DetectorEntry>> = OnceLock::new();
    REGISTRY.get_or_init(build_registry)
}

fn build_registry() -> Vec<DetectorEntry> {
    vec![
        // OpenSilver core patterns.
        opensilver(
            DetectorKind::OpenSilverOwnable,
            0x01,
            &[("owner_pubkey", 32), ("pending_owner_pubkey", 32)],
        ),
        opensilver(
            DetectorKind::OpenSilverMultisig,
            0x02,
            &[("signer_pubkeys", 96), ("threshold", 1)],
        ),
        opensilver(
            DetectorKind::OpenSilverTimeLock,
            0x03,
            &[("unlock_daa_score", 8), ("beneficiary_pubkey", 32)],
        ),
        opensilver(
            DetectorKind::OpenSilverVault,
            0x04,
            &[
                ("owner_pubkey", 32),
                ("recovery_pubkey", 32),
                ("recovery_delay_blocks", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverEscrowBilateral,
            0x05,
            &[
                ("buyer_pubkey", 32),
                ("seller_pubkey", 32),
                ("arbiter_pubkey", 32),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverEscrowMilestone,
            0x06,
            &[
                ("buyer_pubkey", 32),
                ("seller_pubkey", 32),
                ("milestone_root", 32),
                ("milestone_count", 1),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverStreamingPayment,
            0x07,
            &[
                ("sender_pubkey", 32),
                ("recipient_pubkey", 32),
                ("rate_per_block", 8),
                ("start_daa", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverVesting,
            0x08,
            &[
                ("beneficiary_pubkey", 32),
                ("cliff_daa", 8),
                ("end_daa", 8),
                ("total_amount", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverDeadMansSwitch,
            0x09,
            &[
                ("owner_pubkey", 32),
                ("heir_pubkey", 32),
                ("checkin_interval_blocks", 8),
                ("last_checkin_daa", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverSocialRecovery,
            0x0A,
            &[
                ("owner_pubkey", 32),
                ("guardian_root", 32),
                ("guardian_threshold", 1),
                ("recovery_delay_blocks", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverAtomicSwapHTLC,
            0x0B,
            &[
                ("alice_pubkey", 32),
                ("bob_pubkey", 32),
                ("hash_lock", 32),
                ("timeout_daa", 8),
            ],
        ),
        opensilver(
            DetectorKind::OpenSilverFreelancePayroll,
            0x0C,
            &[
                ("payer_pubkey", 32),
                ("worker_root", 32),
                ("worker_count", 1),
                ("period_blocks", 8),
            ],
        ),
        // Native KCC20 — per-UTXO receipt state (kcc20.sil Pattern 4.1):
        // each covenant UTXO carries its own owner / amount / minter flag.
        // Widths verified against a real `silverc` compile of kcc20.sil — the
        // 46-byte state slot sits at script offset 1 (bound-independent), with
        // owner_identifier[2..33] / identifier_type[35] / amount[37..44] (an
        // 8-byte i64, not 16) / is_minter[46]. (Offsets within the placeholder
        // fingerprint are still synthetic; only the field widths are real —
        // see NEXT_SESSION on the anchored-matcher fingerprint sync.)
        opensilver(
            DetectorKind::KCC20Asset,
            0x20,
            &[
                ("owner_identifier", 32),
                ("identifier_type", 1),
                ("amount", 8),
                ("is_minter", 1),
            ],
        ),
        opensilver(
            DetectorKind::KCC20OwnableController,
            0x21,
            &[
                ("owner_pubkey", 32),
                ("pending_owner_pubkey", 32),
                ("asset_covenant_id", 32),
            ],
        ),
        opensilver(
            DetectorKind::KCC20PausableController,
            0x22,
            &[
                ("owner_pubkey", 32),
                ("paused_flag", 1),
                ("asset_covenant_id", 32),
            ],
        ),
        opensilver(
            DetectorKind::KCC20CappedController,
            0x23,
            &[
                ("owner_pubkey", 32),
                ("remaining_allowance", 16),
                ("asset_covenant_id", 32),
            ],
        ),
        opensilver(
            DetectorKind::KCC20VestingController,
            0x24,
            &[
                ("owner_pubkey", 32),
                ("schedule_root", 32),
                ("schedule_count", 1),
                ("asset_covenant_id", 32),
            ],
        ),
    ]
}

/// Build a placeholder fingerprint for one pattern. The shape is:
///
/// ```text
/// [DISCRIMINATOR(2)] [PROLOGUE(8)] [STATE_FIELDS(variable)] [EPILOGUE(8)]
/// ```
///
/// - The discriminator pins the pattern. `0xFE` is a placeholder
///   prefix that no compiled OpenSilver script begins with today, so
///   no false positives on real chain data.
/// - The prologue and epilogue are fixed canonical bytes.
/// - The state fields are concatenated masked windows.
fn opensilver(
    kind: DetectorKind,
    discriminator: u8,
    fields: &[(&'static str, usize)],
) -> DetectorEntry {
    const PROLOGUE: [u8; 8] = [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11];
    const EPILOGUE: [u8; 8] = [0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22];
    const HEADER_LEN: usize = 2;

    let mut bytes = Vec::new();
    bytes.push(0xFE);
    bytes.push(discriminator);
    bytes.extend_from_slice(&PROLOGUE);

    let mut windows = Vec::with_capacity(fields.len());
    let mut cursor = HEADER_LEN + PROLOGUE.len();
    for &(field, len) in fields {
        // Pad with zero bytes inside the state window; bytes here
        // don't matter for matching, only the offset/len does.
        bytes.extend(std::iter::repeat(0u8).take(len));
        windows.push(MaskedWindow {
            field: field_label(kind, field),
            offset: cursor,
            len,
        });
        cursor += len;
    }

    bytes.extend_from_slice(&EPILOGUE);

    let fingerprint = Fingerprint {
        bytes,
        masked_windows: windows,
    };
    DetectorEntry { kind, fingerprint }
}

/// Map a generic field name (e.g. `"owner_pubkey"`) to a static
/// string. Without this we'd need to leak Strings into `&'static
/// str` at runtime; instead we hard-code the field labels each
/// pattern is allowed to emit.
fn field_label(kind: DetectorKind, raw: &str) -> &'static str {
    macro_rules! label {
        ($($s:literal),* $(,)?) => {
            match raw {
                $($s => $s,)*
                other => panic!("unknown field label {other} for {:?}", kind),
            }
        };
    }
    label!(
        // OpenSilver core
        "owner_pubkey",
        "pending_owner_pubkey",
        "signer_pubkeys",
        "threshold",
        "unlock_daa_score",
        "beneficiary_pubkey",
        "recovery_pubkey",
        "recovery_delay_blocks",
        "buyer_pubkey",
        "seller_pubkey",
        "arbiter_pubkey",
        "milestone_root",
        "milestone_count",
        "sender_pubkey",
        "recipient_pubkey",
        "rate_per_block",
        "start_daa",
        "cliff_daa",
        "end_daa",
        "total_amount",
        "heir_pubkey",
        "checkin_interval_blocks",
        "last_checkin_daa",
        "guardian_root",
        "guardian_threshold",
        "alice_pubkey",
        "bob_pubkey",
        "hash_lock",
        "timeout_daa",
        "payer_pubkey",
        "worker_root",
        "worker_count",
        "period_blocks",
        // KCC20 asset (per-UTXO receipt state)
        "owner_identifier",
        "identifier_type",
        "amount",
        "is_minter",
        // KCC20 controllers
        "asset_covenant_id",
        "paused_flag",
        "remaining_allowance",
        "schedule_root",
        "schedule_count",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_registry_entry_has_a_valid_fingerprint() {
        for entry in all() {
            entry
                .fingerprint
                .validate()
                .unwrap_or_else(|e| panic!("invalid fingerprint for {:?}: {e}", entry.kind));
        }
    }

    #[test]
    fn every_entry_has_a_unique_kind() {
        let mut seen = std::collections::HashSet::new();
        for entry in all() {
            assert!(seen.insert(entry.kind), "duplicate kind {:?}", entry.kind);
        }
    }

    #[test]
    fn every_entry_has_a_unique_discriminator() {
        let mut seen = std::collections::HashSet::new();
        for entry in all() {
            let disc = (entry.fingerprint.bytes[0], entry.fingerprint.bytes[1]);
            assert!(
                seen.insert(disc),
                "duplicate discriminator {:?} for {:?}",
                disc,
                entry.kind
            );
        }
    }

    #[test]
    fn each_fingerprint_matches_a_script_built_from_its_own_bytes() {
        for entry in all() {
            assert!(
                entry.fingerprint.matches(&entry.fingerprint.bytes),
                "fingerprint for {:?} does not match its own canonical bytes",
                entry.kind
            );
        }
    }

    #[test]
    fn entries_do_not_cross_match_each_other() {
        let entries = all();
        for a in entries {
            for b in entries {
                if a.kind == b.kind {
                    continue;
                }
                // A different pattern's canonical bytes should not
                // match this one — discriminators differ.
                assert!(
                    !a.fingerprint.matches(&b.fingerprint.bytes)
                        || a.fingerprint.bytes.len() != b.fingerprint.bytes.len(),
                    "{:?} cross-matches {:?}",
                    a.kind,
                    b.kind
                );
            }
        }
    }
}
