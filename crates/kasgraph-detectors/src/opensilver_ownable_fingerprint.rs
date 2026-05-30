//! Real exact fingerprint for the OpenSilver `Ownable` covenant
//! (`contracts/core/ownable.sil`), captured from actual `silverc` output.
//!
//! Unlike KCC20, `Ownable` takes no loop-bound constructor params — its whole
//! state is `(owner, has_pending_owner, pending_owner)` — so it compiles to a
//! fixed-size script and is matched with an exact [`Fingerprint`] (not the
//! anchored matcher KCC20 needs). The canonical script bytes are the
//! compile-time output with the per-instance state masked; verified to match a
//! separately-compiled instance with different state and to extract its fields.
//!
//! State window offsets (verified): the 68-byte state slot starts at script
//! byte 1, with `owner_pubkey` `[2..34)`, `has_pending` `[35]`,
//! `pending_owner_pubkey` `[37..69)`; the interleaved bytes (1, 34, 36) are
//! fixed push prefixes. (The old placeholder entry omitted `has_pending` — the
//! real layout has it, so the detector schema gains that field.)
//!
//! Re-capture when the contract changes: compile `ownable.sil` via
//! `OpenSilver/upstream/silverscript/target/debug/silverc` and mask the state
//! slot. The hex is committed as a fixture rather than hand-inlined.

use crate::fingerprint::{Fingerprint, MaskedWindow};

const OWNABLE_SCRIPT_HEX: &str = include_str!("testdata/opensilver_ownable_script.hex");

/// The OpenSilver `Ownable` covenant's exact fingerprint, with its
/// `(owner_pubkey, has_pending, pending_owner_pubkey)` state masked.
pub fn opensilver_ownable_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(OWNABLE_SCRIPT_HEX.trim()).expect("Ownable script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "owner_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "has_pending",
                offset: 35,
                len: 1,
            },
            MaskedWindow {
                field: "pending_owner_pubkey",
                offset: 37,
                len: 32,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `ownable.sil` with state distinct from the
    /// canonical capture: owner = `07`×32, has_pending = true, pending = `09`×32.
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_ownable_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_ownable_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_ownable_fingerprint()
            .match_and_extract(&script)
            .expect("real Ownable instance must match");
        assert_eq!(hex::encode(&out["owner_pubkey"]), "07".repeat(32));
        assert_eq!(hex::encode(&out["has_pending"]), "01");
        assert_eq!(hex::encode(&out["pending_owner_pubkey"]), "09".repeat(32));
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_ownable_fingerprint()
            .match_and_extract(&[0x00u8; 420])
            .is_none());
    }
}
