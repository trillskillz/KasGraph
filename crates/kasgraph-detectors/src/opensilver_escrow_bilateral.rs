//! Real exact fingerprint for the OpenSilver `OpenSilverEscrowBilateral` covenant
//! (`contracts/core/escrow-bilateral.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(buyer_pubkey, seller_pubkey, arbiter_hash, timeout)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 108}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: buyer_pubkey[2..34); seller_pubkey[35..67); arbiter_hash[68..100); timeout[101..109).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const ESCROW_BILATERAL_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_escrow_bilateral_script.hex");

/// The OpenSilver `OpenSilverEscrowBilateral` covenant's exact fingerprint, state masked.
pub fn opensilver_escrow_bilateral_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(ESCROW_BILATERAL_SCRIPT_HEX.trim())
            .expect("OpenSilverEscrowBilateral script hex is valid"),
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

    /// A real `silverc` compile of `escrow-bilateral.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_escrow_bilateral_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_escrow_bilateral_fingerprint()
            .validate()
            .unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_escrow_bilateral_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverEscrowBilateral instance must match");
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
        assert_eq!(hex::encode(&out["timeout"]), "6700000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_escrow_bilateral_fingerprint()
            .match_and_extract(&[0x00u8; 362])
            .is_none());
    }
}
