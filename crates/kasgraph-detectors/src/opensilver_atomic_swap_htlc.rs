//! Real exact fingerprint for the OpenSilver `OpenSilverAtomicSwapHTLC` covenant
//! (`contracts/core/atomic-swap-htlc.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(recipient_pubkey, refunder_pubkey, secret_hash, timeout)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 108}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: recipient_pubkey[2..34); refunder_pubkey[35..67); secret_hash[68..100); timeout[101..109).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const ATOMIC_SWAP_HTLC_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_atomic_swap_htlc_script.hex");

/// The OpenSilver `OpenSilverAtomicSwapHTLC` covenant's exact fingerprint, state masked.
pub fn opensilver_atomic_swap_htlc_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(ATOMIC_SWAP_HTLC_SCRIPT_HEX.trim())
            .expect("OpenSilverAtomicSwapHTLC script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "recipient_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "refunder_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "secret_hash",
                offset: 68,
                len: 32,
            },
            MaskedWindow {
                field: "timeout",
                offset: 101,
                len: 8,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `atomic-swap-htlc.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_atomic_swap_htlc_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_atomic_swap_htlc_fingerprint()
            .validate()
            .unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_atomic_swap_htlc_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverAtomicSwapHTLC instance must match");
        assert_eq!(
            hex::encode(&out["recipient_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(
            hex::encode(&out["refunder_pubkey"]),
            "4141414141414141414141414141414141414141414141414141414141414141"
        );
        assert_eq!(
            hex::encode(&out["secret_hash"]),
            "4242424242424242424242424242424242424242424242424242424242424242"
        );
        assert_eq!(hex::encode(&out["timeout"]), "6700000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_atomic_swap_htlc_fingerprint()
            .match_and_extract(&[0x00u8; 250])
            .is_none());
    }
}
