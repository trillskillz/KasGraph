//! Real anchored fingerprint for the OpenSilver `KCC20VestingController` covenant
//! (`contracts/tokens/kcc20-vesting.sil`), captured from actual `silverc` output.
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
//! State (decl order, `state_layout {start: 1, len: 80}`, offsets via the
//! push-prefix rule): total_allocation[2..10); minted_amount[11..19); cliff_time[20..28); period[29..37); release_per_period[38..46); kcc20_covenant_id[47..79); initialized[80..81). `int` fields are 8-byte little-endian.

use crate::fingerprint::{AnchoredFingerprint, MaskedWindow};

/// Stable head (LCP of the capture compiles), state masked inside.
const KCC20_VESTING_CONTROLLER_HEAD_HEX: &str = "6b08050000000000000008060000000000000008070000000000000008080000000000000008090000000000000020161616161616161616161616161616161616161616161616161616161616161601016c76009c6375567956795679567956795579557955797800a0697600a2697878a269537900a069547900a2695279916901167958799c6901157957799c6901147956799c6901137955799c6901127954799c6901117900d587696079695f7920eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeac69b9cb519c6901167958cd01087c7e01167958cd01087c7e01167958cd01087c7e01167958cd01087c7e01167958cd01087c7e01167901207c7e01167951cd01017c7e7e7e7e7e7e7eb976c902";

/// Stable tail (LCS of the capture compiles), template-independent epilogue.
const KCC20_VESTING_CONTROLLER_TAIL_HEX: &str = "05940151937cbc7eaa02000001aa7e01207e7c7e01877eb900ccc38769007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a75007a7575757575757575757575757575757575757575757575757551677500696868";

/// The OpenSilver `KCC20VestingController` covenant's anchored fingerprint, state `(total_allocation, minted_amount, cliff_time, period, release_per_period, kcc20_covenant_id, initialized)`
/// masked in the head.
pub fn kcc20_vesting_controller_fingerprint() -> AnchoredFingerprint {
    AnchoredFingerprint {
        head: hex::decode(KCC20_VESTING_CONTROLLER_HEAD_HEX)
            .expect("KCC20VestingController head hex is valid"),
        head_masked_windows: vec![
            MaskedWindow {
                field: "total_allocation",
                offset: 2,
                len: 8,
            },
            MaskedWindow {
                field: "minted_amount",
                offset: 11,
                len: 8,
            },
            MaskedWindow {
                field: "cliff_time",
                offset: 20,
                len: 8,
            },
            MaskedWindow {
                field: "period",
                offset: 29,
                len: 8,
            },
            MaskedWindow {
                field: "release_per_period",
                offset: 38,
                len: 8,
            },
            MaskedWindow {
                field: "kcc20_covenant_id",
                offset: 47,
                len: 32,
            },
            MaskedWindow {
                field: "initialized",
                offset: 80,
                len: 1,
            },
        ],
        tail: hex::decode(KCC20_VESTING_CONTROLLER_TAIL_HEX)
            .expect("KCC20VestingController tail hex is valid"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `kcc20-vesting.sil` at an UNSEEN template (content +
    /// length never used in the capture compiles) carrying distinct state.
    const INSTANCE_HEX: &str = include_str!("testdata/kcc20_vesting_controller_instance.hex");

    #[test]
    fn fingerprint_validates() {
        kcc20_vesting_controller_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_unseen_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = kcc20_vesting_controller_fingerprint()
            .match_and_extract(&script)
            .expect("real KCC20VestingController instance must match");
        assert_eq!(hex::encode(&out["total_allocation"]), "e803000000000000");
        assert_eq!(hex::encode(&out["minted_amount"]), "e903000000000000");
        assert_eq!(hex::encode(&out["cliff_time"]), "ea03000000000000");
        assert_eq!(hex::encode(&out["period"]), "eb03000000000000");
        assert_eq!(hex::encode(&out["release_per_period"]), "ec03000000000000");
        assert_eq!(
            hex::encode(&out["kcc20_covenant_id"]),
            "4545454545454545454545454545454545454545454545454545454545454545"
        );
        assert_eq!(hex::encode(&out["initialized"]), "01");
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(kcc20_vesting_controller_fingerprint()
            .match_and_extract(&[0x00u8; 64])
            .is_none());
    }
}
