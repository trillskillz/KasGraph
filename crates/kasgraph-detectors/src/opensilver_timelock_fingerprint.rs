//! Real exact fingerprint for the OpenSilver `TimeLock` covenant
//! (`contracts/core/timelock.sil`), captured from actual `silverc` output.
//!
//! Like `Ownable`, TimeLock takes no loop-bound constructor params, so it
//! compiles to a fixed-size script and is matched with an exact
//! [`Fingerprint`]. Its state is `(owner, beneficiary, unlock_time,
//! soft_cancel_enabled)`. The window offsets were computed from the artifact's
//! `state_layout` via the verified push-prefix rule (each state value is
//! preceded by a 1-byte push opcode, so field `i` sits at `start + 1 +
//! Σ_{j<i}(width_j + 1)`) and confirmed by matching a separately-compiled
//! instance: `owner_pubkey[2..34)`, `beneficiary_pubkey[35..67)`,
//! `unlock_time[68..76)` (8-byte little-endian i64), `soft_cancel[77]`.
//!
//! (The old placeholder entry declared only `unlock_daa_score`/
//! `beneficiary_pubkey` — the real layout has four fields, now in the schema.)

use crate::fingerprint::{Fingerprint, MaskedWindow};

const TIMELOCK_SCRIPT_HEX: &str = include_str!("testdata/opensilver_timelock_script.hex");

/// The OpenSilver `TimeLock` covenant's exact fingerprint, with its
/// `(owner, beneficiary, unlock_time, soft_cancel)` state masked.
pub fn opensilver_timelock_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(TIMELOCK_SCRIPT_HEX.trim()).expect("TimeLock script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "owner_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "beneficiary_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "unlock_time",
                offset: 68,
                len: 8,
            },
            MaskedWindow {
                field: "soft_cancel",
                offset: 77,
                len: 1,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `timelock.sil` with state distinct from the
    /// canonical capture: owner=`07`×32, beneficiary=`08`×32, unlock_time=999,
    /// soft_cancel=true.
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_timelock_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_timelock_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_timelock_fingerprint()
            .match_and_extract(&script)
            .expect("real TimeLock instance must match");
        assert_eq!(hex::encode(&out["owner_pubkey"]), "07".repeat(32));
        assert_eq!(hex::encode(&out["beneficiary_pubkey"]), "08".repeat(32));
        // 8-byte little-endian i64: 999 = 0x03E7 -> e7 03 00 ...
        assert_eq!(hex::encode(&out["unlock_time"]), "e703000000000000");
        assert_eq!(hex::encode(&out["soft_cancel"]), "01");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_timelock_fingerprint()
            .match_and_extract(&[0x00u8; 368])
            .is_none());
    }
}
