//! Real exact fingerprint for the OpenSilver `OpenSilverEscrowMilestone` covenant
//! (`contracts/core/escrow-milestone.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(buyer_pubkey, seller_pubkey, arbiter_hash, total_milestones, completed_milestones, timeout)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 126}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: buyer_pubkey[2..34); seller_pubkey[35..67); arbiter_hash[68..100); total_milestones[101..109); completed_milestones[110..118); timeout[119..127).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const ESCROW_MILESTONE_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_escrow_milestone_script.hex");

/// The OpenSilver `OpenSilverEscrowMilestone` covenant's exact fingerprint, state masked.
pub fn opensilver_escrow_milestone_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(ESCROW_MILESTONE_SCRIPT_HEX.trim())
            .expect("OpenSilverEscrowMilestone script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "buyer_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "seller_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "arbiter_hash",
                offset: 68,
                len: 32,
            },
            MaskedWindow {
                field: "total_milestones",
                offset: 101,
                len: 8,
            },
            MaskedWindow {
                field: "completed_milestones",
                offset: 110,
                len: 8,
            },
            MaskedWindow {
                field: "timeout",
                offset: 119,
                len: 8,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `escrow-milestone.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_escrow_milestone_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_escrow_milestone_fingerprint()
            .validate()
            .unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_escrow_milestone_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverEscrowMilestone instance must match");
        assert_eq!(
            hex::encode(&out["buyer_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(
            hex::encode(&out["seller_pubkey"]),
            "4141414141414141414141414141414141414141414141414141414141414141"
        );
        assert_eq!(
            hex::encode(&out["arbiter_hash"]),
            "4242424242424242424242424242424242424242424242424242424242424242"
        );
        assert_eq!(hex::encode(&out["total_milestones"]), "6700000000000000");
        assert_eq!(
            hex::encode(&out["completed_milestones"]),
            "6800000000000000"
        );
        assert_eq!(hex::encode(&out["timeout"]), "6900000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_escrow_milestone_fingerprint()
            .match_and_extract(&[0x00u8; 732])
            .is_none());
    }
}
