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
//! structured receipt states. The `KCC20Asset` detector now carries a **real**
//! anchored fingerprint (`crate::kcc20_asset_fingerprint`), so on-chain
//! receipt state is honestly extractable; [`kcc20_spend_operation`] is the
//! bridge from a spend's consumed + created receipt payloads to its operation.
//! What remains is the node spend-loop wiring (group by spending tx, gather
//! the consumed/created sets, classify, build `CovenantSpend`, dispatch).

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
    /// `amount` is an 8-byte **little-endian** i64 (SilverScript's on-chain int
    /// encoding); `identifier_type` / `is_minter` are 1-byte flags.
    pub fn from_payload(payload: &Value) -> Result<Self, Kcc20DecodeError> {
        Ok(Self {
            owner_identifier: hex_str(payload, "owner_identifier")?.to_owned(),
            identifier_type: hex_byte(payload, "identifier_type")? as u8,
            // 8-byte little-endian i64: silverscript stores `int` LE on chain
            // (verified against a real kcc20.sil compile — amount 999 extracts
            // as `e703000000000000` from script bytes [37..45)).
            amount: hex_le_u64(payload, "amount")?,
            is_minter: hex_byte(payload, "is_minter")? != 0,
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

/// Resolve a KCC20 asset spend's operation from the detector payloads (the
/// `locked_state` JSON of each tracked covenant UTXO) of the receipts the
/// spend **consumed** and **created**. This is the bridge the node spend path
/// calls: it already has the consumed receipts (`lookup_covenant_utxo` per
/// input) and the created ones (`covenant_utxos_created_by_tx`), each carrying
/// a `locked_state` payload. Returns the classified operation, or a
/// `Kcc20DecodeError` if any payload isn't a well-formed receipt (so the
/// caller leaves `operation` undetermined rather than guessing). Fork-safe:
/// classification is over the full sets, so a 1→N transfer reads correctly.
pub fn kcc20_spend_operation(
    consumed: &[Value],
    created: &[Value],
) -> Result<Kcc20Operation, Kcc20DecodeError> {
    let parse = |payloads: &[Value]| -> Result<Vec<Kcc20ReceiptState>, Kcc20DecodeError> {
        payloads
            .iter()
            .map(Kcc20ReceiptState::from_payload)
            .collect()
    };
    Ok(classify_kcc20_operation(
        &parse(consumed)?,
        &parse(created)?,
    ))
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

/// Decode a single-byte hex field (`identifier_type`, `is_minter`). Endianness
/// is moot for one byte; rejects wider input.
fn hex_byte(payload: &Value, field: &'static str) -> Result<u8, Kcc20DecodeError> {
    let bytes =
        hex::decode(hex_str(payload, field)?).map_err(|_| Kcc20DecodeError::NotHex(field))?;
    match bytes.as_slice() {
        [b] => Ok(*b),
        _ => Err(Kcc20DecodeError::Overflow(field)),
    }
}

/// Decode a **little-endian** hex field into a `u128`, bounded to 8 bytes (an
/// i64 slot). SilverScript stores `int` little-endian in the redeem script, so
/// `amount`'s extracted bytes are LE (verified against a real kcc20.sil
/// compile).
fn hex_le_u64(payload: &Value, field: &'static str) -> Result<u128, Kcc20DecodeError> {
    let bytes =
        hex::decode(hex_str(payload, field)?).map_err(|_| Kcc20DecodeError::NotHex(field))?;
    if bytes.len() > 8 {
        return Err(Kcc20DecodeError::Overflow(field));
    }
    Ok(bytes
        .iter()
        .enumerate()
        .fold(0u128, |acc, (i, &b)| acc | ((b as u128) << (8 * i))))
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
            "amount": "0001000000000000", // 8-byte LE i64 slot, = 256
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

    fn payload(owner: &str, id_type: &str, amount_le: &str, minter: &str) -> serde_json::Value {
        json!({
            "owner_identifier": owner,
            "identifier_type": id_type,
            "amount": amount_le,
            "is_minter": minter,
        })
    }

    #[test]
    fn spend_operation_classifies_from_consumed_and_created_payload_sets() {
        // 1→2 holder transfer: 1000 in -> 600 + 400 out, supply conserved.
        let consumed = [payload("aa", "00", "e803000000000000", "00")]; // 1000 LE
        let created = [
            payload("aa", "00", "5802000000000000", "00"), // 600
            payload("bb", "00", "9001000000000000", "00"), // 400
        ];
        assert_eq!(
            kcc20_spend_operation(&consumed, &created).unwrap(),
            Kcc20Operation::Transfer
        );

        // Mint: minter branch held, a new 500 holder receipt created (1000 -> 1500).
        let consumed = [payload("ctrl", "02", "e803000000000000", "01")];
        let created = [
            payload("ctrl", "02", "e803000000000000", "01"),
            payload("alice", "00", "f401000000000000", "00"), // 500
        ];
        assert_eq!(
            kcc20_spend_operation(&consumed, &created).unwrap(),
            Kcc20Operation::Mint
        );
    }

    #[test]
    fn spend_operation_propagates_a_malformed_receipt_payload() {
        let consumed =
            [json!({ "owner_identifier": "aa", "identifier_type": "00", "is_minter": "00" })];
        let created = [payload("aa", "00", "0a", "00")];
        assert_eq!(
            kcc20_spend_operation(&consumed, &created),
            Err(Kcc20DecodeError::MissingField("amount"))
        );
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
