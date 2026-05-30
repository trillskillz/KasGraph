//! Real anchored fingerprint for the OpenSilver `KCC20CappedController` covenant
//! (`contracts/tokens/kcc20-capped.sil`), captured from actual `silverc` output.
//!
//! Like the native KCC20 asset, the controllers embed a **variable-length
//! template** (the controlled asset covenant's `templatePrefix`/`templateSuffix`
//! and `expectedTemplateHash`, supplied per deployment) into the redeem script, so
//! the script length and middle bytes vary across deployments and it cannot be
//! matched byte-exact. It is matched with an
//! [`crate::fingerprint::AnchoredFingerprint`]: a stable head (containing the
//! masked state) + a stable tail, with the template middle unconstrained.
//!
//! The head/tail are the longest common prefix/suffix of three `silverc`
//! compiles that share identical state but use **different template content and
//! length**, so the per-deployment template is excluded from both anchors. The
//! capture was verified against a fourth, unseen instance carrying entirely
//! different state AND a template never used in capture: it matches and the
//! state extracts correctly.
//!
//! State (decl order, `state_layout {start: 1, len: 53}`, offsets via the
//! push-prefix rule): kcc20_covenant_id[2..34); total_cap[35..43); remaining_allowance[44..52); initialized[53..54). `int` fields are 8-byte little-endian.

use crate::fingerprint::{AnchoredFingerprint, MaskedWindow};

/// Stable head (LCP of the capture compiles), state masked inside.
const KCC20_CAPPED_CONTROLLER_HEAD_HEX: &str = "6b20111111111111111111111111111111111111111111111111111111111111111108060000000000000008070000000000000001006c76009c6375527952795279527952797800a2697600a2697878a269527991695d7900d587695c7955799c695b7954799c695a7969597920eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeac69b9cb519c695d7901207c7e5d7958cd01087c7e5d7958cd01087c7e5d7951cd01017c7e7e7e7eb976c902";

/// Stable tail (LCS of the capture compiles), template-independent epilogue.
const KCC20_CAPPED_CONTROLLER_TAIL_HEX: &str = "04940136937cbc7eaa02000001aa7e01207e7c7e01877eb900ccc38769007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75757575757575757575757575757575757551677500696868";

/// The OpenSilver `KCC20CappedController` covenant's anchored fingerprint, state `(kcc20_covenant_id, total_cap, remaining_allowance, initialized)`
/// masked in the head.
pub fn kcc20_capped_controller_fingerprint() -> AnchoredFingerprint {
    AnchoredFingerprint {
        head: hex::decode(KCC20_CAPPED_CONTROLLER_HEAD_HEX)
            .expect("KCC20CappedController head hex is valid"),
        head_masked_windows: vec![
            MaskedWindow {
                field: "kcc20_covenant_id",
                offset: 2,
                len: 32,
            },
            MaskedWindow {
                field: "total_cap",
                offset: 35,
                len: 8,
            },
            MaskedWindow {
                field: "remaining_allowance",
                offset: 44,
                len: 8,
            },
            MaskedWindow {
                field: "initialized",
                offset: 53,
                len: 1,
            },
        ],
        tail: hex::decode(KCC20_CAPPED_CONTROLLER_TAIL_HEX)
            .expect("KCC20CappedController tail hex is valid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `kcc20-capped.sil` at an UNSEEN template (content +
    /// length never used in the capture compiles) carrying distinct state.
    const INSTANCE_HEX: &str = include_str!("testdata/kcc20_capped_controller_instance.hex");

    #[test]
    fn fingerprint_validates() {
        kcc20_capped_controller_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_unseen_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = kcc20_capped_controller_fingerprint()
            .match_and_extract(&script)
            .expect("real KCC20CappedController instance must match");
        assert_eq!(
            hex::encode(&out["kcc20_covenant_id"]),
            "4040404040404040404040404040404040404040404040404040404040404040"
        );
        assert_eq!(hex::encode(&out["total_cap"]), "e903000000000000");
        assert_eq!(hex::encode(&out["remaining_allowance"]), "ea03000000000000");
        assert_eq!(hex::encode(&out["initialized"]), "01");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(kcc20_capped_controller_fingerprint()
            .match_and_extract(&[0x00u8; 64])
            .is_none());
    }
}
