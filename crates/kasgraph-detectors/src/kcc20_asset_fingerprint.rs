//! The first **real** covenant fingerprint: the native KCC20 asset covenant
//! (`kcc20.sil` Pattern 4.1), captured from actual `silverc` output.
//!
//! KCC20 unrolls its `maxCovIns`/`maxCovOuts` loops into the redeem script, so
//! it cannot be matched byte-exact across deployments (see
//! [`crate::fingerprint::AnchoredFingerprint`]). The head/tail below are the
//! bound-independent anchors `derive_anchored_fingerprint` produced from
//! compiles at bounds (4,4) and (8,8); they were verified to match an instance
//! at an unseen bound (5,5) carrying entirely different state, and to extract
//! the receipt fields at the empirically-mapped offsets.
//!
//! State window offsets (verified, bound-independent): the 46-byte state slot
//! starts at script byte 1, with `owner_identifier` `[2..34)`, `identifier_type`
//! `[35]`, `amount` `[37..45)` (8-byte **little-endian** i64), `is_minter`
//! `[46]`. The interleaved bytes (1, 34, 36, 45) are fixed push prefixes and
//! stay part of the matched head.
//!
//! Captured by: compile `kcc20.sil` at ≥2 bound settings via
//! `OpenSilver/upstream/silverscript/target/debug/silverc`
//! (`--constructor-args` JSON), then `derive_anchored_fingerprint`. When the
//! contract changes, re-capture. This is the worked example the per-pattern
//! capture xtask generalizes.

use crate::fingerprint::{AnchoredFingerprint, MaskedWindow};

/// Stable 64-byte head (state masked inside) from the (4,4) compile. The
/// state bytes here are that compile's genesis values — masked, so ignored.
const HEAD_HEX: &str = "6b200101010101010101010101010101010101010101010101010101010101010101010008e80300000000000001006c76009c6375b9cf7600d1b99c6976d076";

/// Stable 154-byte tail (bound-independent script epilogue).
const TAIL_HEX: &str = "94012f937cbc7eaa02000001aa7e01207e7c7e01877e78c38769785193537a75777768007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a7575757575757575757575516776519c6375b9cf00d1b99e697575757551677500696868";

/// The native KCC20 asset covenant's anchored fingerprint, with the per-UTXO
/// receipt state windows masked in the head. Field names match the
/// `KCC20Asset` registry entry and feed
/// [`crate::kcc20_operation::Kcc20ReceiptState::from_payload`].
pub fn kcc20_asset_fingerprint() -> AnchoredFingerprint {
    AnchoredFingerprint {
        head: hex::decode(HEAD_HEX).expect("KCC20 asset head hex is valid"),
        head_masked_windows: vec![
            MaskedWindow {
                field: "owner_identifier",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "identifier_type",
                offset: 35,
                len: 1,
            },
            MaskedWindow {
                field: "amount",
                offset: 37,
                len: 8,
            },
            MaskedWindow {
                field: "is_minter",
                offset: 46,
                len: 1,
            },
        ],
        tail: hex::decode(TAIL_HEX).expect("KCC20 asset tail hex is valid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kcc20_operation::Kcc20ReceiptState;

    /// A real `silverc` compile of `kcc20.sil` at an UNSEEN bound (5,5) with
    /// state distinct from the capture compiles: owner = `07`×32,
    /// identifier_type = 2 (COVENANT_ID), amount = 999, is_minter = true.
    const INSTANCE_HEX: &str = include_str!("testdata/kcc20_asset_instance.hex");

    #[test]
    fn fingerprint_validates() {
        kcc20_asset_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_unseen_instance_and_extracts_receipt_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let fp = kcc20_asset_fingerprint();

        // Matches a real instance at a bound the head/tail were NOT derived
        // from, carrying entirely different state — the whole point of the
        // anchored matcher.
        let out = fp
            .match_and_extract(&script)
            .expect("real KCC20 asset instance must match");
        assert_eq!(hex::encode(&out["owner_identifier"]), "07".repeat(32));
        assert_eq!(hex::encode(&out["identifier_type"]), "02");
        // Little-endian on chain: 999 = 0x03E7 -> e7 03 00 ...
        assert_eq!(hex::encode(&out["amount"]), "e703000000000000");
        assert_eq!(hex::encode(&out["is_minter"]), "01");

        // End-to-end: the extracted hex fields decode to the right receipt
        // state via the operation decoder's parser (proves the LE handling).
        let payload = serde_json::json!({
            "owner_identifier": hex::encode(&out["owner_identifier"]),
            "identifier_type": hex::encode(&out["identifier_type"]),
            "amount": hex::encode(&out["amount"]),
            "is_minter": hex::encode(&out["is_minter"]),
        });
        let receipt = Kcc20ReceiptState::from_payload(&payload).unwrap();
        assert_eq!(receipt.amount, 999);
        assert_eq!(receipt.identifier_type, 2);
        assert!(receipt.is_minter);
    }

    #[test]
    fn rejects_a_script_that_is_not_this_pattern() {
        // Truncated / unrelated bytes must not match.
        assert!(kcc20_asset_fingerprint()
            .match_and_extract(&[0x00u8; 300])
            .is_none());
    }
}
