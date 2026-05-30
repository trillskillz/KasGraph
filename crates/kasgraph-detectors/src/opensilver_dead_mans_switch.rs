//! Real exact fingerprint for the OpenSilver `OpenSilverDeadMansSwitch` covenant
//! (`contracts/core/dead-man-switch.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(owner_pubkey, fallback_pubkey, timeout_age, last_ping_age)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 84}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: owner_pubkey[2..34); fallback_pubkey[35..67); timeout_age[68..76); last_ping_age[77..85).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const DEAD_MANS_SWITCH_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_dead_mans_switch_script.hex");

/// The OpenSilver `OpenSilverDeadMansSwitch` covenant's exact fingerprint, state masked.
pub fn opensilver_dead_mans_switch_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(DEAD_MANS_SWITCH_SCRIPT_HEX.trim())
            .expect("OpenSilverDeadMansSwitch script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "owner_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "fallback_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "timeout_age",
                offset: 68,
                len: 8,
            },
            MaskedWindow {
                field: "last_ping_age",
                offset: 77,
                len: 8,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `dead-man-switch.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_dead_mans_switch_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_dead_mans_switch_fingerprint()
            .validate()
            .unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_dead_mans_switch_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverDeadMansSwitch instance must match");
        assert_eq!(
            hex::encode(&out["owner_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(
            hex::encode(&out["fallback_pubkey"]),
            "4141414141414141414141414141414141414141414141414141414141414141"
        );
        assert_eq!(hex::encode(&out["timeout_age"]), "6600000000000000");
        assert_eq!(hex::encode(&out["last_ping_age"]), "6700000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_dead_mans_switch_fingerprint()
            .match_and_extract(&[0x00u8; 454])
            .is_none());
    }
}
