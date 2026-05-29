//! Pure operation decoder for native KCC20 covenant spends.
//!
//! KCC20 follows a **per-UTXO receipt** model (OpenSilver Pattern 4.1,
//! `contracts/tokens/kcc20.sil`): every KCC20 covenant UTXO carries its own
//! state — `ownerIdentifier` (byte[32]: a pubkey, P2SH script hash, or the
//! controller's covenant id), `identifierType` (which of those it is),
//! `amount`, and `isMinter` (the mint-capable branch). There is **no**
//! aggregate `total_supply` field on chain; supply is the sum of the live
//! receipts' `amount`s.
//!
//! A spend consumes a set of input receipts (`prevStates`) and produces a set
//! of output receipts (`newStates`). The protocol *operation* is **not tagged
//! on-chain** — it is a pure function of the receipt-set delta, per the
//! `kcc20.sil` invariants:
//!
//!   - `checkAmounts` requires `sum(prev.amount) == sum(new.amount)` on every
//!     non-minter path; only a minter branch (`isMinter`) may change the sum.
//!     So a rise in the summed amount is a **mint** and a fall is a **burn**.
//!   - With supply conserved, the spend either redistributes ownership among
//!     receipts (a **transfer**) or re-points the minter branch's controller
//!     binding — the `isMinter` receipt whose `ownerIdentifier` is a
//!     controller covenant id (`identifierType == COVENANT_ID`). A change to
//!     that binding is a **controller rotation**.
//!
//! This is the actual reference-contract model (it replaced an earlier
//! aggregate `total_supply`/`mint_nonce` model that did not match
//! `kcc20.sil`). The classifier is pure and extraction-agnostic: it takes
//! structured receipt states, so it is unit-tested today over hand-built
//! receipts and `from_payload`-parsed detector payloads. It is **not yet
//! wired into the node spend path**: honest classification needs the receipt
//! states read out of the on-chain state window, and the fingerprint registry
//! still carries placeholder bytes (real OpenSilver compiled-script + state
//! offsets are a separate, pending export). Wiring against placeholder
//! extraction would classify fake state and mislead the spend mappings, so it
//! lands as a pure core — the same discipline as `krc20_ledger`.

use std::collections::BTreeSet;

use serde_json::Value;

/// `identifierType == COVENANT_ID` — the `ownerIdentifier` is a controller
/// covenant id rather than a pubkey/script hash (`kcc20.sil` constant
/// `IDENTIFIER_COVENANT_ID`).
pub const IDENTIFIER_COVENANT_ID: u8 = 0x02;

/// One KCC20 covenant receipt's on-chain state — the `KCC20Asset` state window
/// the indexer extracts, matching the `kcc20.sil` per-UTXO layout.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kcc20ReceiptState {
    /// `byte[32]`: a holder pubkey, a P2SH script hash, or a controller
    /// covenant id, disambiguated by [`Self::identifier_type`]. Hex; only ever
    /// compared for equality, never interpreted.
    pub owner_identifier: String,
    /// `0x00` PUBKEY | `0x01` SCRIPT_HASH | `0x02` COVENANT_ID.
    pub identifier_type: u8,
    /// This receipt's token amount. Supply is the sum across live receipts.
    pub amount: u128,
    /// Whether this is the mint-capable branch (`kcc20.sil` `isMinter`). Only
    /// minter branches may change the summed amount.
    pub is_minter: bool,
}

impl Kcc20ReceiptState {
    /// Parse one receipt from a detector hit payload — the hex-string field
    /// map `kasgraph_detectors::payload_to_json` produces for a `KCC20Asset`
    /// match (`owner_identifier` / `identifier_type` / `amount` / `is_minter`).
    /// Numeric fields are big-endian hex of their declared width; `is_minter`
    /// is a 1-byte flag (any non-zero byte = true).
    pub fn from_payload(payload: &Value) -> Result<Self, Kcc20DecodeError> {
        Ok(Self {
            owner_identifier: hex_str(payload, "owner_identifier")?.to_owned(),
            identifier_type: hex_be(payload, "identifier_type", 1)? as u8,
            // 8 bytes: silverscript `int` is i64 — matches the verified
            // kcc20.sil state slot (amount at script bytes [37..44]).
            amount: hex_be(payload, "amount", 8)?,
            is_minter: hex_be(payload, "is_minter", 1)? != 0,
        })
    }

    /// Whether this receipt is the minter branch bound to a controller covenant
    /// — the receipt whose `ownerIdentifier` is a controller covenant id.
    fn is_controller_binding(&self) -> bool {
        self.is_minter && self.identifier_type == IDENTIFIER_COVENANT_ID
    }
}

/// The protocol operation a KCC20 spend performed. The string forms match the
/// codegen `CovenantSpend.operation` values the spend mappings branch on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kcc20Operation {
    Transfer,
    Mint,
    Burn,
    RotateController,
}

impl Kcc20Operation {
    /// The protocol operation string (the value `examples/krc20` branches on).
    pub fn as_str(self) -> &'static str {
        match self {
            Kcc20Operation::Transfer => "transfer",
            Kcc20Operation::Mint => "mint",
            Kcc20Operation::Burn => "burn",
            Kcc20Operation::RotateController => "rotate_controller",
        }
    }
}

/// Why a KCC20 receipt could not be parsed from a detector payload.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Kcc20DecodeError {
    #[error("missing field `{0}` in KCC20 receipt payload")]
    MissingField(&'static str),
    #[error("field `{0}` is not valid hex in KCC20 receipt payload")]
    NotHex(&'static str),
    #[error("field `{0}` is wider than its declared width in KCC20 receipt payload")]
    Overflow(&'static str),
}

/// Classify a KCC20 spend from the input/output receipt-set delta. Operations
/// are mutually exclusive per spend: a rise in the summed `amount` is a mint
/// and a fall is a burn (only a minter branch can change the sum, per
/// `kcc20.sil` `checkAmounts`); with the sum conserved, a change to the minter
/// branch's controller binding (`isMinter` + `identifierType == COVENANT_ID`
/// `ownerIdentifier`) is a controller rotation, and otherwise the spend is a
/// transfer. Supply delta is checked first so a mint that also re-points the
/// controller still reports as a mint.
pub fn classify_kcc20_operation(
    prev: &[Kcc20ReceiptState],
    next: &[Kcc20ReceiptState],
) -> Kcc20Operation {
    use std::cmp::Ordering::{Equal, Greater, Less};
    let total_in = sum_amounts(prev);
    let total_out = sum_amounts(next);
    match total_out.cmp(&total_in) {
        Greater => Kcc20Operation::Mint,
        Less => Kcc20Operation::Burn,
        Equal if controller_bindings(prev) != controller_bindings(next) => {
            Kcc20Operation::RotateController
        }
        Equal => Kcc20Operation::Transfer,
    }
}

fn sum_amounts(receipts: &[Kcc20ReceiptState]) -> u128 {
    receipts
        .iter()
        .fold(0u128, |acc, r| acc.saturating_add(r.amount))
}

/// The set of controller covenant ids bound on the minter branches. A change
/// to this set (with supply conserved) is a controller rotation.
fn controller_bindings(receipts: &[Kcc20ReceiptState]) -> BTreeSet<&str> {
    receipts
        .iter()
        .filter(|r| r.is_controller_binding())
        .map(|r| r.owner_identifier.as_str())
        .collect()
}

fn hex_str<'a>(payload: &'a Value, field: &'static str) -> Result<&'a str, Kcc20DecodeError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or(Kcc20DecodeError::MissingField(field))
}

/// Decode a big-endian hex field into a `u128`, rejecting input wider than
/// `max_bytes` (the field's declared width).
fn hex_be(
    payload: &Value,
    field: &'static str,
    max_bytes: usize,
) -> Result<u128, Kcc20DecodeError> {
    let bytes =
        hex::decode(hex_str(payload, field)?).map_err(|_| Kcc20DecodeError::NotHex(field))?;
    if bytes.len() > max_bytes {
        return Err(Kcc20DecodeError::Overflow(field));
    }
    Ok(bytes.iter().fold(0u128, |acc, &b| (acc << 8) | b as u128))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn receipt(owner: &str, id_type: u8, amount: u128, is_minter: bool) -> Kcc20ReceiptState {
        Kcc20ReceiptState {
            owner_identifier: owner.into(),
            identifier_type: id_type,
            amount,
            is_minter,
        }
    }

    #[test]
    fn operation_strings_match_the_mapping_branches() {
        assert_eq!(Kcc20Operation::Transfer.as_str(), "transfer");
        assert_eq!(Kcc20Operation::Mint.as_str(), "mint");
        assert_eq!(Kcc20Operation::Burn.as_str(), "burn");
        assert_eq!(
            Kcc20Operation::RotateController.as_str(),
            "rotate_controller"
        );
    }

    #[test]
    fn summed_amount_increase_is_a_mint() {
        // A minter branch mints 500 into a holder receipt: 1000 in -> 1500 out.
        let prev = [receipt("ctrl", IDENTIFIER_COVENANT_ID, 1000, true)];
        let next = [
            receipt("ctrl", IDENTIFIER_COVENANT_ID, 1000, true),
            receipt("alice", 0, 500, false),
        ];
        assert_eq!(classify_kcc20_operation(&prev, &next), Kcc20Operation::Mint);
    }

    #[test]
    fn summed_amount_decrease_is_a_burn() {
        let prev = [receipt("alice", 0, 1000, false)];
        let next = [receipt("alice", 0, 700, false)];
        assert_eq!(classify_kcc20_operation(&prev, &next), Kcc20Operation::Burn);
    }

    #[test]
    fn conserved_supply_with_ownership_change_is_a_transfer() {
        // Alice's 1000 receipt splits into 600 (alice) + 400 (bob); sum held.
        let prev = [receipt("alice", 0, 1000, false)];
        let next = [
            receipt("alice", 0, 600, false),
            receipt("bob", 0, 400, false),
        ];
        assert_eq!(
            classify_kcc20_operation(&prev, &next),
            Kcc20Operation::Transfer
        );
    }

    #[test]
    fn conserved_supply_with_controller_rebinding_is_a_rotation() {
        // The minter branch re-points from controller "ctrl-a" to "ctrl-b".
        let prev = [receipt("ctrl-a", IDENTIFIER_COVENANT_ID, 1000, true)];
        let next = [receipt("ctrl-b", IDENTIFIER_COVENANT_ID, 1000, true)];
        assert_eq!(
            classify_kcc20_operation(&prev, &next),
            Kcc20Operation::RotateController
        );
    }

    #[test]
    fn a_holder_owner_change_alone_is_not_a_rotation() {
        // A non-minter owner change is an ordinary transfer, not a rotation —
        // only the minter/controller binding distinguishes rotation.
        let prev = [receipt("alice", 0, 1000, false)];
        let next = [receipt("bob", 0, 1000, false)];
        assert_eq!(
            classify_kcc20_operation(&prev, &next),
            Kcc20Operation::Transfer
        );
    }

    #[test]
    fn supply_delta_takes_precedence_over_a_controller_rebinding() {
        let prev = [receipt("ctrl-a", IDENTIFIER_COVENANT_ID, 1000, true)];
        let next = [receipt("ctrl-b", IDENTIFIER_COVENANT_ID, 2000, true)];
        assert_eq!(classify_kcc20_operation(&prev, &next), Kcc20Operation::Mint);
    }

    #[test]
    fn from_payload_parses_the_hex_field_map() {
        let payload = json!({
            "owner_identifier": "ab".repeat(32),
            "identifier_type": "02",
            "amount": "0000000000000100", // 8-byte i64 slot, = 256
            "is_minter": "01",
        });
        let parsed = Kcc20ReceiptState::from_payload(&payload).unwrap();
        assert_eq!(parsed.owner_identifier, "ab".repeat(32));
        assert_eq!(parsed.identifier_type, IDENTIFIER_COVENANT_ID);
        assert_eq!(parsed.amount, 256);
        assert!(parsed.is_minter);
    }

    #[test]
    fn from_payload_round_trips_into_classification() {
        let prev_p = json!({
            "owner_identifier": "alice", "identifier_type": "00",
            "amount": "0a", "is_minter": "00", // 10
        });
        let next_p = json!({
            "owner_identifier": "alice", "identifier_type": "00",
            "amount": "14", "is_minter": "00", // 20
        });
        let prev = [Kcc20ReceiptState::from_payload(&prev_p).unwrap()];
        let next = [Kcc20ReceiptState::from_payload(&next_p).unwrap()];
        assert_eq!(classify_kcc20_operation(&prev, &next).as_str(), "mint");
    }

    #[test]
    fn from_payload_rejects_missing_non_hex_and_oversized_fields() {
        let missing =
            json!({ "owner_identifier": "aa", "identifier_type": "00", "is_minter": "00" });
        assert_eq!(
            Kcc20ReceiptState::from_payload(&missing),
            Err(Kcc20DecodeError::MissingField("amount"))
        );
        let bad = json!({ "owner_identifier": "aa", "identifier_type": "00", "amount": "zz", "is_minter": "00" });
        assert_eq!(
            Kcc20ReceiptState::from_payload(&bad),
            Err(Kcc20DecodeError::NotHex("amount"))
        );
        let big = json!({
            "owner_identifier": "aa", "identifier_type": "00",
            "amount": "00".repeat(17), "is_minter": "00",
        });
        assert_eq!(
            Kcc20ReceiptState::from_payload(&big),
            Err(Kcc20DecodeError::Overflow("amount"))
        );
    }
}
