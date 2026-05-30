//! Pattern registry — the list of fingerprints `detect_in_output`
//! walks.
//!
//! Most entries are now **real** fingerprints captured from `silverc`
//! compiles of the OpenSilver contracts: all the fixed-size core
//! patterns (Ownable, MultiSig, TimeLock, Vault, the two Escrows,
//! StreamingPayment, Vesting, DeadMansSwitch, SocialRecovery,
//! AtomicSwapHTLC, FreelancePayroll) as exact [`Fingerprint`]s, plus
//! the loop-unrolled native KCC20 asset as an
//! [`crate::fingerprint::AnchoredFingerprint`]. The remaining KCC20
//! *controller* entries are still placeholders pending capture.
//!
//! Each placeholder uses a unique two-byte discriminator
//! (`0xFE, 0x<n>`) so synthetic patterns never collide with each
//! other or with the real captures (no compiled OpenSilver script
//! begins with `0xFE`).

use std::sync::OnceLock;

use crate::fingerprint::{Fingerprint, MaskedWindow, PatternMatcher};
use crate::kcc20_asset_fingerprint::kcc20_asset_fingerprint;
use crate::opensilver_atomic_swap_htlc::opensilver_atomic_swap_htlc_fingerprint;
use crate::opensilver_dead_mans_switch::opensilver_dead_mans_switch_fingerprint;
use crate::opensilver_escrow_bilateral::opensilver_escrow_bilateral_fingerprint;
use crate::opensilver_escrow_milestone::opensilver_escrow_milestone_fingerprint;
use crate::opensilver_freelance_payroll::opensilver_freelance_payroll_fingerprint;
use crate::opensilver_multisig_fingerprint::opensilver_multisig_fingerprint;
use crate::opensilver_ownable_fingerprint::opensilver_ownable_fingerprint;
use crate::opensilver_social_recovery::opensilver_social_recovery_fingerprint;
use crate::opensilver_streaming_payment::opensilver_streaming_payment_fingerprint;
use crate::opensilver_timelock_fingerprint::opensilver_timelock_fingerprint;
use crate::opensilver_vault_fingerprint::opensilver_vault_fingerprint;
use crate::opensilver_vesting::opensilver_vesting_fingerprint;
use crate::DetectorKind;

/// One entry in the detector registry.
#[derive(Debug, Clone)]
pub struct DetectorEntry {
    pub kind: DetectorKind,
    pub matcher: PatternMatcher,
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
        // OpenSilver core patterns — all real exact fingerprints captured from
        // `silverc` compiles (fixed-size, no loop-bound params). Ownable's state
        // slot adds the `has_pending` flag the placeholder omitted.
        DetectorEntry {
            kind: DetectorKind::OpenSilverOwnable,
            matcher: PatternMatcher::Exact(opensilver_ownable_fingerprint()),
        },
        // Real exact fingerprint (captured from multisig.sil — fixed-size,
        // fixed 3-signer quorum). The real layout is `threshold` (8-byte int)
        // then three separate 32-byte pubkey windows, replacing the
        // placeholder's bundled 96-byte `signer_pubkeys` + 1-byte `threshold`.
        DetectorEntry {
            kind: DetectorKind::OpenSilverMultisig,
            matcher: PatternMatcher::Exact(opensilver_multisig_fingerprint()),
        },
        // Real exact fingerprint (captured from timelock.sil — fixed-size).
        DetectorEntry {
            kind: DetectorKind::OpenSilverTimeLock,
            matcher: PatternMatcher::Exact(opensilver_timelock_fingerprint()),
        },
        // Real exact fingerprint (captured from vault.sil — fixed-size). The
        // nine-field state (owner / has_pending / pending_owner / threshold /
        // pk1..3 / unlock_time / beneficiary) replaces the placeholder's wrong
        // three-field guess.
        DetectorEntry {
            kind: DetectorKind::OpenSilverVault,
            matcher: PatternMatcher::Exact(opensilver_vault_fingerprint()),
        },
        // Real exact fingerprints, captured from the OpenSilver core contracts
        // (all fixed-size — no maxCovIns/maxCovOuts loop params). Each replaces
        // a placeholder whose field layout was a guess; the real state layouts
        // (verified via the push-prefix offset rule + a distinct-state diff) are
        // in the per-pattern fingerprint modules.
        DetectorEntry {
            kind: DetectorKind::OpenSilverEscrowBilateral,
            matcher: PatternMatcher::Exact(opensilver_escrow_bilateral_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverEscrowMilestone,
            matcher: PatternMatcher::Exact(opensilver_escrow_milestone_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverStreamingPayment,
            matcher: PatternMatcher::Exact(opensilver_streaming_payment_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverVesting,
            matcher: PatternMatcher::Exact(opensilver_vesting_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverDeadMansSwitch,
            matcher: PatternMatcher::Exact(opensilver_dead_mans_switch_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverSocialRecovery,
            matcher: PatternMatcher::Exact(opensilver_social_recovery_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverAtomicSwapHTLC,
            matcher: PatternMatcher::Exact(opensilver_atomic_swap_htlc_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::OpenSilverFreelancePayroll,
            matcher: PatternMatcher::Exact(opensilver_freelance_payroll_fingerprint()),
        },
        // Native KCC20 — the FIRST real fingerprint. KCC20 unrolls its
        // maxCovIns/maxCovOuts loops into the script, so it's matched with an
        // anchored head+tail (captured from real silverc compiles) rather than
        // a placeholder. The per-UTXO receipt state (owner_identifier /
        // identifier_type / amount / is_minter) is masked in the head at the
        // verified offsets. See `kcc20_asset_fingerprint`.
        DetectorEntry {
            kind: DetectorKind::KCC20Asset,
            matcher: PatternMatcher::Anchored(kcc20_asset_fingerprint()),
        },
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
        bytes.extend(std::iter::repeat_n(0u8, len));
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
    DetectorEntry {
        kind,
        matcher: PatternMatcher::Exact(fingerprint),
    }
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
                .matcher
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
    fn every_placeholder_entry_has_a_unique_discriminator() {
        // The `0xFE`-prefixed discriminator is the *placeholder* fingerprint
        // scheme. Real captured fingerprints (exact or anchored) don't follow
        // it — they share a common SilverScript prologue and are distinguished
        // by full content instead (the cross-match test below). So this
        // uniqueness check applies only while placeholders remain.
        let mut seen = std::collections::HashSet::new();
        for entry in all() {
            if let PatternMatcher::Exact(f) = &entry.matcher {
                if f.bytes.first() != Some(&0xFE) {
                    continue; // a real captured fingerprint, not a placeholder
                }
                let disc = (f.bytes[0], f.bytes[1]);
                assert!(
                    seen.insert(disc),
                    "duplicate discriminator {:?} for {:?}",
                    disc,
                    entry.kind
                );
            }
        }
    }

    #[test]
    fn each_fingerprint_matches_a_script_built_from_its_own_bytes() {
        for entry in all() {
            assert!(
                entry.matcher.matches(&entry.matcher.sample_script()),
                "fingerprint for {:?} does not match its own representative script",
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
                // No pattern may match another's representative script.
                assert!(
                    !a.matcher.matches(&b.matcher.sample_script()),
                    "{:?} cross-matches {:?}",
                    a.kind,
                    b.kind
                );
            }
        }
    }
}
