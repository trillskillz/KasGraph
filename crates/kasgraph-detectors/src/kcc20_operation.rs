//! Pure operation decoder for native KCC20 asset-covenant spends.
//!
//! A KCC20 asset spend transitions the asset covenant's on-chain state; the
//! protocol *operation* (transfer / mint / burn / rotate_controller) is **not
//! tagged on-chain**. It is a pure function of the delta between the spent
//! asset state and its successor:
//!
//!   - `kcc20.sil`'s `checkAmounts` conserves supply across non-minter
//!     transfers; only a minter branch can change supply. So a rise in the
//!     asset's `total_supply` is a mint and a fall is a burn.
//!   - The asset covenant binds its minting authority to a controller via a
//!     covenant id (`controller_covenant_id`); when supply is unchanged, a
//!     change to that id is a controller rotation, and no change at all is an
//!     ordinary transfer.
//!
//! This matches the indexer's asset-state model (the `KCC20Asset` registry
//! fields `controller_covenant_id` / `total_supply` / `mint_nonce`) and the
//! exact operation strings the `examples/krc20` mapping branches on
//! (`KRC20_KRC721_REFERENCE.md` §"Native KCC20").
//!
//! The classifier is pure and extraction-agnostic: it takes structured state,
//! so it is unit-tested today over hand-built states and `from_payload`-parsed
//! detector payloads. It deliberately is **not yet wired into the node spend
//! path**: real classification needs the asset state read out of the on-chain
//! state window, and the fingerprint registry still carries placeholder bytes
//! (real OpenSilver compiled-script + state-window offsets are a separate,
//! pending export). Wiring it against placeholder extraction would classify
//! fake state and mislead the spend mappings, so it lands as a pure core ahead
//! of that — the same discipline as `krc20_ledger`.

use serde_json::Value;

/// The asset-covenant state the indexer reads from a KCC20 asset's on-chain
/// state window — the subset of the `KCC20Asset` registry fields the operation
/// classification depends on (`decimals` is irrelevant to the operation).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Kcc20AssetState {
    /// Covenant id of the bound controller, hex (registry field
    /// `controller_covenant_id`). A change with supply held constant is a
    /// controller rotation.
    pub controller_covenant_id: String,
    /// Total minted supply (registry field `total_supply`, a 16-byte big-endian
    /// `u128`). Its delta distinguishes mint (up) from burn (down).
    pub total_supply: u128,
    /// Monotonic mint counter (registry field `mint_nonce`, an 8-byte
    /// big-endian `u64`). Carried for completeness / future cross-checks.
    pub mint_nonce: u64,
}

/// The protocol operation a KCC20 asset spend performed. The string forms
/// match the codegen `CovenantSpend.operation` values the spend mappings
/// branch on.
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

/// Why a KCC20 asset state could not be parsed from a detector payload.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Kcc20DecodeError {
    #[error("missing field `{0}` in KCC20 asset payload")]
    MissingField(&'static str),
    #[error("field `{0}` is not valid hex in KCC20 asset payload")]
    NotHex(&'static str),
    #[error("field `{0}` is wider than its integer type in KCC20 asset payload")]
    Overflow(&'static str),
}

impl Kcc20AssetState {
    /// Parse the asset state from a detector hit payload — the hex-string field
    /// map `kasgraph_detectors::payload_to_json` produces for a `KCC20Asset`
    /// match. Numeric fields are big-endian hex of their fixed byte width;
    /// `controller_covenant_id` is kept as its raw hex string (it is only ever
    /// compared for equality, never interpreted).
    pub fn from_payload(payload: &Value) -> Result<Self, Kcc20DecodeError> {
        Ok(Self {
            controller_covenant_id: hex_str(payload, "controller_covenant_id")?.to_owned(),
            total_supply: hex_be_u128(payload, "total_supply")?,
            mint_nonce: hex_be_u64(payload, "mint_nonce")? as u64,
        })
    }
}

/// Classify a KCC20 asset spend from the state delta. Operations are mutually
/// exclusive per spend (one operation per transition): a `total_supply`
/// increase is a mint and a decrease is a burn; with supply unchanged, a
/// change to `controller_covenant_id` is a controller rotation and otherwise
/// the spend is a plain transfer. Supply is checked first so a (hypothetical)
/// mint that also touched the controller binding is still reported as a mint.
pub fn classify_kcc20_asset_operation(
    prior: &Kcc20AssetState,
    next: &Kcc20AssetState,
) -> Kcc20Operation {
    use std::cmp::Ordering::{Equal, Greater, Less};
    match next.total_supply.cmp(&prior.total_supply) {
        Greater => Kcc20Operation::Mint,
        Less => Kcc20Operation::Burn,
        Equal if next.controller_covenant_id != prior.controller_covenant_id => {
            Kcc20Operation::RotateController
        }
        Equal => Kcc20Operation::Transfer,
    }
}

fn hex_str<'a>(payload: &'a Value, field: &'static str) -> Result<&'a str, Kcc20DecodeError> {
    payload
        .get(field)
        .and_then(Value::as_str)
        .ok_or(Kcc20DecodeError::MissingField(field))
}

/// Decode a big-endian hex field into a `u128`, rejecting input wider than 16
/// bytes (the field's declared width).
fn hex_be_u128(payload: &Value, field: &'static str) -> Result<u128, Kcc20DecodeError> {
    let bytes =
        hex::decode(hex_str(payload, field)?).map_err(|_| Kcc20DecodeError::NotHex(field))?;
    if bytes.len() > 16 {
        return Err(Kcc20DecodeError::Overflow(field));
    }
    Ok(bytes.iter().fold(0u128, |acc, &b| (acc << 8) | b as u128))
}

/// Decode a big-endian hex field into a `u128` bounded to 8 bytes (a `u64`).
fn hex_be_u64(payload: &Value, field: &'static str) -> Result<u128, Kcc20DecodeError> {
    let bytes =
        hex::decode(hex_str(payload, field)?).map_err(|_| Kcc20DecodeError::NotHex(field))?;
    if bytes.len() > 8 {
        return Err(Kcc20DecodeError::Overflow(field));
    }
    Ok(bytes.iter().fold(0u128, |acc, &b| (acc << 8) | b as u128))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state(controller: &str, supply: u128, nonce: u64) -> Kcc20AssetState {
        Kcc20AssetState {
            controller_covenant_id: controller.into(),
            total_supply: supply,
            mint_nonce: nonce,
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
    fn supply_increase_is_a_mint() {
        let prior = state("aa", 1_000, 4);
        let next = state("aa", 1_500, 5);
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next),
            Kcc20Operation::Mint
        );
    }

    #[test]
    fn supply_decrease_is_a_burn() {
        let prior = state("aa", 1_000, 5);
        let next = state("aa", 700, 5);
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next),
            Kcc20Operation::Burn
        );
    }

    #[test]
    fn conserved_supply_with_controller_change_is_a_rotation() {
        let prior = state("aa", 1_000, 5);
        let next = state("bb", 1_000, 5);
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next),
            Kcc20Operation::RotateController
        );
    }

    #[test]
    fn conserved_supply_and_controller_is_a_transfer() {
        let prior = state("aa", 1_000, 5);
        let next = state("aa", 1_000, 5);
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next),
            Kcc20Operation::Transfer
        );
    }

    #[test]
    fn supply_delta_takes_precedence_over_a_controller_change() {
        // A mint that also re-pointed the controller still reports as a mint.
        let prior = state("aa", 1_000, 5);
        let next = state("bb", 2_000, 6);
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next),
            Kcc20Operation::Mint
        );
    }

    #[test]
    fn from_payload_parses_the_hex_field_map() {
        // total_supply = 16-byte BE for 0x0100 = 256; mint_nonce = 8-byte BE 3.
        let payload = json!({
            "controller_covenant_id": "ab".repeat(32),
            "decimals": "08",
            "total_supply": "00000000000000000000000000000100",
            "mint_nonce": "0000000000000003",
        });
        let parsed = Kcc20AssetState::from_payload(&payload).unwrap();
        assert_eq!(parsed.controller_covenant_id, "ab".repeat(32));
        assert_eq!(parsed.total_supply, 256);
        assert_eq!(parsed.mint_nonce, 3);
    }

    #[test]
    fn from_payload_round_trips_into_classification() {
        let prior_payload = json!({
            "controller_covenant_id": "aa",
            "total_supply": "0a", // 10
            "mint_nonce": "01",
        });
        let next_payload = json!({
            "controller_covenant_id": "aa",
            "total_supply": "14", // 20
            "mint_nonce": "02",
        });
        let prior = Kcc20AssetState::from_payload(&prior_payload).unwrap();
        let next = Kcc20AssetState::from_payload(&next_payload).unwrap();
        assert_eq!(
            classify_kcc20_asset_operation(&prior, &next).as_str(),
            "mint"
        );
    }

    #[test]
    fn from_payload_rejects_missing_non_hex_and_oversized_fields() {
        // Missing total_supply.
        let missing = json!({ "controller_covenant_id": "aa", "mint_nonce": "01" });
        assert_eq!(
            Kcc20AssetState::from_payload(&missing),
            Err(Kcc20DecodeError::MissingField("total_supply"))
        );
        // Non-hex total_supply.
        let bad =
            json!({ "controller_covenant_id": "aa", "total_supply": "zz", "mint_nonce": "01" });
        assert_eq!(
            Kcc20AssetState::from_payload(&bad),
            Err(Kcc20DecodeError::NotHex("total_supply"))
        );
        // total_supply wider than 16 bytes overflows the u128 field.
        let big = json!({
            "controller_covenant_id": "aa",
            "total_supply": "00".repeat(17),
            "mint_nonce": "01",
        });
        assert_eq!(
            Kcc20AssetState::from_payload(&big),
            Err(Kcc20DecodeError::Overflow("total_supply"))
        );
    }
}
