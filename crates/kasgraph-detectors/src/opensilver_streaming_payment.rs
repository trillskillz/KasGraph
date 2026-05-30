//! Real exact fingerprint for the OpenSilver `OpenSilverStreamingPayment` covenant
//! (`contracts/core/streaming-payment.sil`), captured from actual `silverc` output.
//!
//! Fixed-size (no loop-bound constructor params), so it is matched with an
//! exact [`Fingerprint`]. State: `(sender_pubkey, recipient_pubkey, rate_per_claim, total_allowance, remaining_allowance, period, next_release_time)`.
//!
//! Window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 111}`) via the verified push-prefix rule
//! (`start + 1 + Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real
//! compiles with distinct state: every differing byte falls inside one of these
//! windows and nowhere else, and the last window ends exactly at `start + len`.
//! Layout: sender_pubkey[2..34); recipient_pubkey[35..67); rate_per_claim[68..76); total_allowance[77..85); remaining_allowance[86..94); period[95..103); next_release_time[104..112).

use crate::fingerprint::{Fingerprint, MaskedWindow};

const STREAMING_PAYMENT_SCRIPT_HEX: &str =
    include_str!("testdata/opensilver_streaming_payment_script.hex");

/// The OpenSilver `OpenSilverStreamingPayment` covenant's exact fingerprint, state masked.
pub fn opensilver_streaming_payment_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(STREAMING_PAYMENT_SCRIPT_HEX.trim())
            .expect("OpenSilverStreamingPayment script hex is valid"),
        masked_windows: vec![
            MaskedWindow {
                field: "sender_pubkey",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "recipient_pubkey",
                offset: 35,
                len: 32,
            },
            MaskedWindow {
                field: "rate_per_claim",
                offset: 68,
                len: 8,
            },
            MaskedWindow {
                field: "total_allowance",
                offset: 77,
                len: 8,
            },
            MaskedWindow {
                field: "remaining_allowance",
                offset: 86,
                len: 8,
            },
            MaskedWindow {
                field: "period",
                offset: 95,
                len: 8,
            },
            MaskedWindow {
                field: "next_release_time",
                offset: 104,
                len: 8,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `streaming-payment.sil` with state distinct from the
    /// canonical capture (each field given a unique value).
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_streaming_payment_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_streaming_payment_fingerprint()
            .validate()
            .unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_streaming_payment_fingerprint()
            .match_and_extract(&script)
            .expect("real OpenSilverStreamingPayment instance must match");
        assert_eq!(
            hex::encode(&out["sender_pubkey"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(
            hex::encode(&out["recipient_pubkey"]),
            "4141414141414141414141414141414141414141414141414141414141414141"
        );
        assert_eq!(hex::encode(&out["rate_per_claim"]), "6600000000000000");
        assert_eq!(hex::encode(&out["total_allowance"]), "6700000000000000");
        assert_eq!(hex::encode(&out["remaining_allowance"]), "6800000000000000");
        assert_eq!(hex::encode(&out["period"]), "6900000000000000");
        assert_eq!(hex::encode(&out["next_release_time"]), "6a00000000000000");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_streaming_payment_fingerprint()
            .match_and_extract(&[0x00u8; 800])
            .is_none());
    }
}
