//! Pattern registry — the list of fingerprints `detect_in_output`
//! walks.
//!
//! **Every entry is a real fingerprint captured from a `silverc`
//! compile of its OpenSilver contract** — there are no placeholders
//! left. The fixed-size patterns (Ownable, MultiSig, TimeLock, Vault,
//! the two Escrows, StreamingPayment, Vesting, DeadMansSwitch,
//! SocialRecovery, AtomicSwapHTLC, FreelancePayroll) are exact
//! [`crate::fingerprint::Fingerprint`]s; the loop-unrolled / template-
//! parameterized patterns (the native KCC20 asset + the four KCC20
//! controllers) are [`crate::fingerprint::AnchoredFingerprint`]s
//! (stable head with masked state + stable tail, variable middle).
//! Each capture was verified against an independently compiled
//! instance carrying different state (and, for the anchored ones, an
//! unseen loop bound / template). See the per-pattern modules.

use std::sync::OnceLock;

use crate::fingerprint::PatternMatcher;
use crate::kcc20_asset_fingerprint::kcc20_asset_fingerprint;
use crate::kcc20_capped_controller::kcc20_capped_controller_fingerprint;
use crate::kcc20_ownable_controller::kcc20_ownable_controller_fingerprint;
use crate::kcc20_pausable_controller::kcc20_pausable_controller_fingerprint;
use crate::kcc20_vesting_controller::kcc20_vesting_controller_fingerprint;
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
        // KCC20 controller family — real anchored fingerprints. Each controller
        // embeds a per-deployment variable-length template (the controlled
        // asset covenant's prefix/suffix/hash) into the script, so like the
        // KCC20 asset they're matched with an anchored head+tail (state masked
        // in the head; template middle unconstrained). Captured + verified
        // against an unseen-template instance in the per-pattern modules.
        DetectorEntry {
            kind: DetectorKind::KCC20OwnableController,
            matcher: PatternMatcher::Anchored(kcc20_ownable_controller_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::KCC20PausableController,
            matcher: PatternMatcher::Anchored(kcc20_pausable_controller_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::KCC20CappedController,
            matcher: PatternMatcher::Anchored(kcc20_capped_controller_fingerprint()),
        },
        DetectorEntry {
            kind: DetectorKind::KCC20VestingController,
            matcher: PatternMatcher::Anchored(kcc20_vesting_controller_fingerprint()),
        },
    ]
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
    fn no_placeholder_fingerprints_remain() {
        // The whole registry is now real captures (exact + anchored). The old
        // `0xFE`-prefixed placeholder scheme is gone; this guards against one
        // creeping back in.
        for entry in all() {
            if let PatternMatcher::Exact(f) = &entry.matcher {
                assert_ne!(
                    f.bytes.first(),
                    Some(&0xFE),
                    "{:?} still uses a 0xFE placeholder fingerprint",
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
