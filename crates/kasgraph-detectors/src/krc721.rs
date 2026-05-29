//! Legacy KRC-721 (Kasplex inscription-era) envelope parsing.
//!
//! The legacy KRC-721 NFT protocol mirrors legacy KRC-20: operations are
//! JSON inscriptions carried in the transaction *payload* field (not in
//! any script). This module is the pure parser for that envelope; the
//! ownership/ledger state machine builds on top of it in
//! [`crate::krc721_ledger`].
//!
//! The canonical envelope (per
//! `docs/references/KRC20_KRC721_REFERENCE.md`):
//!
//! ```json
//! {
//!   "p": "krc-721",
//!   "op": "deploy" | "mint" | "transfer" | "burn",
//!   "tick": "COLLECTION",
//!   "max": "<u64>",      // deploy only — collection size
//!   "id":  "<u64>",      // mint/transfer/burn — token id within collection
//!   "uri": "<string>",   // mint only — metadata uri
//!   "to":  "kaspa:..."   // transfer only — recipient
//! }
//! ```
//!
//! `max` and `id` are decimal u64 strings. Ticks are normalized to
//! lowercase ASCII (`tick`), preserving the original text (`tick_raw`).

use serde::{Deserialize, Serialize};

/// A parsed, validated legacy KRC-721 operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum Krc721Op {
    /// Register a collection. `max` is the collection's token count: valid
    /// token ids are `0..max`.
    Deploy { max: u64 },
    /// Mint token `id` to the sender with metadata `uri`.
    Mint { id: u64, uri: String },
    /// Move token `id` from the sender to `to`.
    Transfer { id: u64, to: String },
    /// Destroy token `id` (the sender must own it).
    Burn { id: u64 },
}

/// A fully parsed legacy KRC-721 inscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Krc721Inscription {
    /// Tick normalized to lowercase ASCII — the canonical collection key.
    pub tick: String,
    /// Original tick text, preserved for display (`tickRaw`).
    pub tick_raw: String,
    pub op: Krc721Op,
}

/// The outcome of attempting to parse a transaction payload as a legacy
/// KRC-721 inscription. Mirrors [`crate::krc20::Krc20Parse`]: a payload
/// that isn't a KRC-721 envelope is ignored silently, while a KRC-721
/// envelope that fails validation is dropped but logged at debug for
/// later reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Krc721Parse {
    /// Not a legacy KRC-721 payload (not JSON, or `p != "krc-721"`).
    NotKrc721,
    /// A `p == "krc-721"` payload that fails validation (missing field,
    /// non-numeric id/max, non-ASCII or empty tick, unknown op).
    Malformed(&'static str),
    /// A valid inscription ready for the acceptance state machine.
    Valid(Krc721Inscription),
}

/// Raw shape of the envelope before validation. Every operational field
/// is optional here because validation depends on `op`; missing-field
/// rules are enforced in [`parse_krc721_inscription`].
#[derive(Deserialize)]
struct RawEnvelope {
    p: Option<String>,
    op: Option<String>,
    tick: Option<String>,
    max: Option<String>,
    id: Option<String>,
    uri: Option<String>,
    to: Option<String>,
}

/// Parse a transaction payload as a legacy KRC-721 inscription.
///
/// Returns [`Krc721Parse::NotKrc721`] when the payload is not a KRC-721
/// envelope (not UTF-8 JSON, or `p` is absent / not `"krc-721"`). Returns
/// [`Krc721Parse::Malformed`] when the envelope claims to be KRC-721 but
/// violates an acceptance precondition.
pub fn parse_krc721_inscription(payload: &[u8]) -> Krc721Parse {
    let env: RawEnvelope = match serde_json::from_slice(payload) {
        Ok(env) => env,
        Err(_) => return Krc721Parse::NotKrc721,
    };

    if env.p.as_deref() != Some("krc-721") {
        return Krc721Parse::NotKrc721;
    }

    let tick_raw = match env.tick {
        Some(tick) => tick,
        None => return Krc721Parse::Malformed("missing tick"),
    };
    if tick_raw.is_empty() || !tick_raw.is_ascii() {
        return Krc721Parse::Malformed("tick must be non-empty ASCII");
    }
    let tick = tick_raw.to_ascii_lowercase();

    let op = match env.op.as_deref() {
        Some("deploy") => match parse_u64(env.max.as_deref()) {
            Some(max) => Krc721Op::Deploy { max },
            None => return Krc721Parse::Malformed("deploy requires a numeric max"),
        },
        Some("mint") => {
            let id = match parse_u64(env.id.as_deref()) {
                Some(id) => id,
                None => return Krc721Parse::Malformed("mint requires a numeric id"),
            };
            let uri = match env.uri {
                Some(uri) if !uri.is_empty() => uri,
                _ => return Krc721Parse::Malformed("mint requires a metadata uri"),
            };
            Krc721Op::Mint { id, uri }
        }
        Some("transfer") => {
            let id = match parse_u64(env.id.as_deref()) {
                Some(id) => id,
                None => return Krc721Parse::Malformed("transfer requires a numeric id"),
            };
            let to = match env.to {
                Some(to) if !to.is_empty() => to,
                _ => return Krc721Parse::Malformed("transfer requires a recipient"),
            };
            Krc721Op::Transfer { id, to }
        }
        Some("burn") => match parse_u64(env.id.as_deref()) {
            Some(id) => Krc721Op::Burn { id },
            None => return Krc721Parse::Malformed("burn requires a numeric id"),
        },
        _ => return Krc721Parse::Malformed("unknown or missing op"),
    };

    Krc721Parse::Valid(Krc721Inscription { tick, tick_raw, op })
}

/// Parse a decimal u64 string with no sign, whitespace, or decoration.
fn parse_u64(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Krc721Parse {
        parse_krc721_inscription(json.as_bytes())
    }

    #[test]
    fn non_json_payload_is_not_krc721() {
        assert_eq!(
            parse_krc721_inscription(b"not json at all"),
            Krc721Parse::NotKrc721
        );
    }

    #[test]
    fn json_without_krc721_protocol_is_not_krc721() {
        assert_eq!(
            parse(r#"{"p":"krc-20","op":"mint"}"#),
            Krc721Parse::NotKrc721
        );
        assert_eq!(
            parse(r#"{"op":"mint","tick":"TEST"}"#),
            Krc721Parse::NotKrc721
        );
    }

    #[test]
    fn deploy_parses_max_and_normalizes_tick() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"deploy","tick":"Punks","max":"10000"}"#),
            Krc721Parse::Valid(Krc721Inscription {
                tick: "punks".to_owned(),
                tick_raw: "Punks".to_owned(),
                op: Krc721Op::Deploy { max: 10_000 },
            })
        );
    }

    #[test]
    fn mint_requires_id_and_uri() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"mint","tick":"PUNKS","id":"42","uri":"ipfs://x"}"#),
            Krc721Parse::Valid(Krc721Inscription {
                tick: "punks".to_owned(),
                tick_raw: "PUNKS".to_owned(),
                op: Krc721Op::Mint {
                    id: 42,
                    uri: "ipfs://x".to_owned()
                },
            })
        );
        // Missing uri is malformed.
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"mint","tick":"PUNKS","id":"42"}"#),
            Krc721Parse::Malformed(_)
        ));
        // Empty uri is malformed.
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"mint","tick":"PUNKS","id":"42","uri":""}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn transfer_requires_id_and_recipient() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"transfer","tick":"PUNKS","id":"7","to":"kaspa:qabc"}"#),
            Krc721Parse::Valid(Krc721Inscription {
                tick: "punks".to_owned(),
                tick_raw: "PUNKS".to_owned(),
                op: Krc721Op::Transfer {
                    id: 7,
                    to: "kaspa:qabc".to_owned()
                },
            })
        );
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"transfer","tick":"PUNKS","id":"7"}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn burn_requires_id() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"PUNKS","id":"9"}"#),
            Krc721Parse::Valid(Krc721Inscription {
                tick: "punks".to_owned(),
                tick_raw: "PUNKS".to_owned(),
                op: Krc721Op::Burn { id: 9 },
            })
        );
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"PUNKS"}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn unknown_op_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"frobnicate","tick":"PUNKS"}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn non_numeric_id_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"mint","tick":"PUNKS","id":"4.5","uri":"x"}"#),
            Krc721Parse::Malformed(_)
        ));
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"mint","tick":"PUNKS","id":"-1","uri":"x"}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn non_ascii_or_empty_tick_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"pünks","id":"1"}"#),
            Krc721Parse::Malformed(_)
        ));
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"","id":"1"}"#),
            Krc721Parse::Malformed(_)
        ));
    }

    #[test]
    fn id_at_u64_ceiling_parses_but_overflow_is_malformed() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"PUNKS","id":"18446744073709551615"}"#),
            Krc721Parse::Valid(Krc721Inscription {
                tick: "punks".to_owned(),
                tick_raw: "PUNKS".to_owned(),
                op: Krc721Op::Burn { id: u64::MAX },
            })
        );
        assert!(matches!(
            parse(r#"{"p":"krc-721","op":"burn","tick":"PUNKS","id":"18446744073709551616"}"#),
            Krc721Parse::Malformed(_)
        ));
    }
}
