//! Real exact fingerprint for the OpenSilver `OpenSilverVesting` covenant
//! (`contracts/core/vesting.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(beneficiary_pubkey, admin_pubkey, total_allocation, claimed_amount, cliff_time, period, release_per_period, revocable)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 113}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: beneficiary_pubkey[2..34); admin_pubkey[35..67); total_allocation[68..76); claimed_amount[77..85); cliff_time[86..94); period[95..103); release_per_period[104..112); revocable[113..114).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const VESTING_SCRIPT_HEX: &str = include_str!("testdata/opensilver_vesting_script.hex");

/// The OpenSilver `OpenSilverVesting` covenant's exact fingerprint, state masked.
pub fn opensilver_vesting_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(VESTING_SCRIPT_HEX.trim())
            .expect("OpenSilverVesting script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "beneficiary_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "admin_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "total_allocation",
                offset: 68,
                len: 8,
            },
            MaskedWindow {
                field: "claimed_amount",
                offset: 77,
                len: 8,
            },
            MaskedWindow {
                field: "cliff_time",
                offset: 86,
                len: 8,
            },
            MaskedWindow {
                field: "period",
                offset: 95,
                len: 8,
            },
            MaskedWindow {
                field: "release_per_period",
                offset: 104,
                len: 8,
            },
            MaskedWindow {
                field: "revocable",
                offset: 113,
                len: 1,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `vesting.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_vesting_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_vesting_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_vesting_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverVesting instance must match");
        assert_eq!(
            hex::encode(&out["beneficiary_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(
            hex::encode(&out["admin_pubkey"]),
            "4141414141414141414141414141414141414141414141414141414141414141"
        );
        assert_eq!(hex::encode(&out["total_allocation"]), "6600000000000000");
        assert_eq!(hex::encode(&out["claimed_amount"]), "6700000000000000");
        assert_eq!(hex::encode(&out["cliff_time"]), "6800000000000000");
        assert_eq!(hex::encode(&out["period"]), "6900000000000000");
        assert_eq!(hex::encode(&out["release_per_period"]), "6a00000000000000");
        assert_eq!(hex::encode(&out["revocable"]), "01");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_vesting_fingerprint()
            .match_and_extract(&[0x00u8; 873])
            .is_none());
    }
}
