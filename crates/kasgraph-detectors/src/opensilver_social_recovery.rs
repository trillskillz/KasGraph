//! Real exact fingerprint for the OpenSilver `OpenSilverSocialRecovery` covenant
//! (`contracts/core/social-recovery.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(owner_pubkey, has_pending_owner, pending_owner_pubkey, guardian_threshold, guardian_pubkey_1, guardian_pubkey_2, guardian_pubkey_3, activation_time, recovery_delay)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 194}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: owner_pubkey[2..34); has_pending_owner[35..36); pending_owner_pubkey[37..69); guardian_threshold[70..78); guardian_pubkey_1[79..111); guardian_pubkey_2[112..144); guardian_pubkey_3[145..177); activation_time[178..186); recovery_delay[187..195).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const SOCIAL_RECOVERY_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_social_recovery_script.hex");

/// The OpenSilver `OpenSilverSocialRecovery` covenant's exact fingerprint, state masked.
pub fn opensilver_social_recovery_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(SOCIAL_RECOVERY_SCRIPT_HEX.trim())
            .expect("OpenSilverSocialRecovery script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "owner_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "has_pending_owner",
                offset: 35,
                len: 1,
            },
            MaskedWindow {
                field: "pending_owner_pubkey",
                offset: 37,
                len: 32,
            },
            MaskedWindow {
                field: "guardian_threshold",
                offset: 70,
                len: 8,
            },
            MaskedWindow {
                field: "guardian_pubkey_1",
                offset: 79,
                len: 32,
            },
            MaskedWindow {
                field: "guardian_pubkey_2",
                offset: 112,
                len: 32,
            },
            MaskedWindow {
                field: "guardian_pubkey_3",
                offset: 145,
                len: 32,
            },
            MaskedWindow {
                field: "activation_time",
                offset: 178,
                len: 8,
            },
            MaskedWindow {
                field: "recovery_delay",
                offset: 187,
                len: 8,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `social-recovery.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_social_recovery_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_social_recovery_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_social_recovery_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverSocialRecovery instance must match");
        assert_eq!(
            hex::encode(&out["owner_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(hex::encode(&out["has_pending_owner"]), "01");
        assert_eq!(
            hex::encode(&out["pending_owner_pubkey"]),
            "4242424242424242424242424242424242424242424242424242424242424242"
        );
        assert_eq!(hex::encode(&out["guardian_threshold"]), "6700000000000000");
        assert_eq!(
            hex::encode(&out["guardian_pubkey_1"]),
            "4444444444444444444444444444444444444444444444444444444444444444"
        );
        assert_eq!(
            hex::encode(&out["guardian_pubkey_2"]),
            "4545454545454545454545454545454545454545454545454545454545454545"
        );
        assert_eq!(
            hex::encode(&out["guardian_pubkey_3"]),
            "4646464646464646464646464646464646464646464646464646464646464646"
        );
        assert_eq!(hex::encode(&out["activation_time"]), "6b00000000000000");
        assert_eq!(hex::encode(&out["recovery_delay"]), "6c00000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_social_recovery_fingerprint()
            .match_and_extract(&[0x00u8; 1260])
            .is_none());
    }
}
