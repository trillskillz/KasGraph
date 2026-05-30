//! Real exact fingerprint for the OpenSilver `Vault` covenant
//! (`contracts/core/vault.sil`), captured from actual `silverc` output.
//!
//! Vault takes no loop-bound constructor params, so it compiles to a
//! fixed-size script and is matched with an exact [`Fingerprint`]. Its state is
//! the nine-field tuple `(owner, has_pending_owner, pending_owner, threshold,
//! pk1, pk2, pk3, unlock_time, beneficiary)` — an owner slot with two-step
//! handoff, an N-of-3 signer quorum, and a timelocked beneficiary release.
//!
//! The window offsets were computed from the artifact's `state_layout`
//! (`{start: 1, len: 218}`) via the verified push-prefix rule (each state value
//! is preceded by a 1-byte push opcode, so field `i` sits at `start + 1 +
//! Σ_{j<i}(width_j + 1)`) and confirmed by diffing two real compiles with
//! distinct state: every differing byte falls inside one of these nine windows
//! and nowhere else. `int` fields (`threshold`, `unlock_time`) are 8-byte
//! little-endian, `has_pending` is a 1-byte bool, the rest are 32-byte pubkeys.
//!
//! (The old placeholder entry declared only `owner_pubkey`/`recovery_pubkey`/
//! `recovery_delay_blocks` — the real layout has nine fields, now in the
//! schema.)

use crate::fingerprint::{Fingerprint, MaskedWindow};

const VAULT_SCRIPT_HEX: &str = include_str!("testdata/opensilver_vault_script.hex");

/// The OpenSilver `Vault` covenant's exact fingerprint, with its nine-field
/// `(owner, has_pending_owner, pending_owner, threshold, pk1, pk2, pk3,
/// unlock_time, beneficiary)` state masked.
pub fn opensilver_vault_fingerprint() -> Fingerprint {
    Fingerprint {
        bytes: hex::decode(VAULT_SCRIPT_HEX.trim()).expect("Vault script hex is valid"),
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
            MaskedWindow {
                field: "threshold",
                offset: 70,
                len: 8,
            },
            MaskedWindow {
                field: "signer_pubkey_1",
                offset: 79,
                len: 32,
            },
            MaskedWindow {
                field: "signer_pubkey_2",
                offset: 112,
                len: 32,
            },
            MaskedWindow {
                field: "signer_pubkey_3",
                offset: 145,
                len: 32,
            },
            MaskedWindow {
                field: "unlock_time",
                offset: 178,
                len: 8,
            },
            MaskedWindow {
                field: "beneficiary_pubkey",
                offset: 187,
                len: 32,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `silverc` compile of `vault.sil` with state distinct from the
    /// canonical capture: owner=`07`×32, has_pending=true, pending_owner=`08`×32,
    /// threshold=3, pk1=`09`×32, pk2=`0a`×32, pk3=`0b`×32, unlock_time=999,
    /// beneficiary=`0c`×32.
    const INSTANCE_HEX: &str = include_str!("testdata/opensilver_vault_instance.hex");

    #[test]
    fn fingerprint_validates() {
        opensilver_vault_fingerprint().validate().unwrap();
    }

    #[test]
    fn matches_real_instance_and_extracts_state() {
        let script = hex::decode(INSTANCE_HEX.trim()).expect("valid instance hex");
        let out = opensilver_vault_fingerprint()
            .match_and_extract(&script)
            .expect("real Vault instance must match");
        assert_eq!(hex::encode(&out["owner_pubkey"]), "07".repeat(32));
        assert_eq!(hex::encode(&out["has_pending"]), "01");
        assert_eq!(hex::encode(&out["pending_owner_pubkey"]), "08".repeat(32));
        // 8-byte little-endian i64: 3 -> 03 00 00 ...
        assert_eq!(hex::encode(&out["threshold"]), "0300000000000000");
        assert_eq!(hex::encode(&out["signer_pubkey_1"]), "09".repeat(32));
        assert_eq!(hex::encode(&out["signer_pubkey_2"]), "0a".repeat(32));
        assert_eq!(hex::encode(&out["signer_pubkey_3"]), "0b".repeat(32));
        // 999 = 0x03E7 -> e7 03 00 ...
        assert_eq!(hex::encode(&out["unlock_time"]), "e703000000000000");
        assert_eq!(hex::encode(&out["beneficiary_pubkey"]), "0c".repeat(32));
    }

    #[test]
    fn rejects_unrelated_script() {
        assert!(opensilver_vault_fingerprint()
            .match_and_extract(&[0x00u8; 2190])
            .is_none());
    }
}
