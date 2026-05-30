//! Real exact fingerprint for the OpenSilver `MultiSig` covenant
//! (`contracts/core/multisig.sil`), captured from actual `silverc` output.
//!
//! MultiSig is a fixed 3-signer N-of-3 quorum with no loop-bound constructor
//! params, so it compiles to a fixed-size script and is matched with an exact
//! [`Fingerprint`]. Its state is `(threshold, pk1, pk2, pk3)`.
//!
//! The window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 108}`) via the verified push-prefix rule (each state value
//! is preceded by a 1-byte push opcode, so field `i` sits at `start + 1 +
//! Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real compiles with
//! distinct state: every differing byte falls inside one of these four windows
//! and nowhere else. `threshold` is an 8-byte little-endian int; the signer
//! keys are 32-byte pubkeys.
//!
//! (The old placeholder entry declared `signer_pubkeys`/`threshold` with the
//! three keys bundled into one 96-byte window and `threshold` as 1 byte — the
//! real layout has `threshold` first as an 8-byte int, then three separate
//! 32-byte pubkey windows, now in the schema.)

use crate::fingerprint::{Fingerprint, MaskedWindow};

const MULTISIG_SCRIPT_HEX: &str = include_str!("testdata/opensilver_multisig_script.hex");

/// The OpenSilver `MultiSig` covenant's exact fingerprint, with its
/// `(threshold, pk1, pk2, pk3)` state masked.
pub fn opensilver_multisig_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(MULTISIG_SCRIPT_HEX.trim()).expect("MultiSig script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "threshold",
                offset: 2,
                len: 8,
            },
            MaskedWindow {
                field: "signer_pubkey_1",
                offset: 11,
                len: 32,
            },
            MaskedWindow {
                field: "signer_pubkey_2",
                offset: 44,
                len: 32,
            },
            MaskedWindow {
                field: "signer_pubkey_3",
                offset: 77,
                len: 32,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `multisig.sil` with state distinct from the
    /// canonical capture: threshold=3, pk1=`07`×32, pk2=`08`×32, pk3=`09`×32.
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_multisig_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_multisig_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_multisig_fingerprint()
            .match_and_extract(&script)
            .expect("real MultiSig instance must match");
        // 8-byte little-endian i64: 3 -> 03 00 00 ...
        assert_eq!(hex::encode(&out["threshold"]), "0300000000000000");
        assert_eq!(hex::encode(&out["signer_pubkey_1"]), "07".repeat(32));
        assert_eq!(hex::encode(&out["signer_pubkey_2"]), "08".repeat(32));
        assert_eq!(hex::encode(&out["signer_pubkey_3"]), "09".repeat(32));
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_multisig_fingerprint()
            .match_and_extract(&[0x00u8; 876])
            .is_none());
    }
}
