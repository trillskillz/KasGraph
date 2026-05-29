//! Legacy KRC-20 (Kasplex inscription-era) envelope parsing.
//!
//! Unlike the native KCC20 covenants the fingerprint engine matches,
//! legacy KRC-20 operations are JSON inscriptions carried in the
//! transaction *payload* field (not in any script). This module is the
//! pure parser for that envelope; the acceptance/ledger state machine
//! and reorg handling (per `docs/references/KRC20_KRC721_REFERENCE.md`)
//! build on top of it in later slices.
//!
//! The canonical envelope (Kasplex-compatible):
//!
//! ```json
//! {
//!   "p": "krc-20",
//!   "op": "deploy" | "mint" | "transfer" | "burn",
//!   "tick": "TICK",
//!   "max":  "<u64 string>",   // deploy only
//!   "lim":  "<u64 string>",   // deploy only, per-mint cap
//!   "amt":  "<u64 string>",   // mint/transfer/burn
//!   "to":   "kaspa:<addr>"    // transfer only (recipient)
//! }
//! ```
//!
//! Amounts are decimal u64 strings. Ticks are normalized to lowercase
//! ASCII (`tick`), preserving the original text (`tick_raw`) for display.

use serde::{Deserialize, Serialize};

/// A parsed, validated legacy KRC-20 operation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "op")]
pub enum Krc20Op {
    /// Register a tick. `max` is total supply; `lim` is the per-mint cap.
    Deploy { max: u64, lim: u64 },
    /// Credit `amt` to the sender (the tx's first input address).
    Mint { amt: u64 },
    /// Move `amt` from the sender to `to`.
    Transfer { amt: u64, to: String },
    /// Decrement the sender's balance (and cumulative minted) by `amt`.
    Burn { amt: u64 },
}

/// A fully parsed legacy KRC-20 inscription.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Krc20Inscription {
    /// Tick normalized to lowercase ASCII — the canonical ledger key.
    pub tick: String,
    /// Original tick text, preserved for display (`tickRaw`).
    pub tick_raw: String,
    pub op: Krc20Op,
}

/// The outcome of attempting to parse a transaction payload as a legacy
/// KRC-20 inscription. The three arms map to the reference doc's handling
/// rules: a payload that isn't a KRC-20 envelope is ignored silently,
/// while a KRC-20 envelope that fails validation is dropped but logged at
/// debug for later reconciliation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Krc20Parse {
    /// Not a legacy KRC-20 payload (not JSON, or `p != "krc-20"`). The
    /// indexer ignores these silently — most transactions are not KRC-20.
    NotKrc20,
    /// A `p == "krc-20"` payload that fails validation (missing field,
    /// non-numeric amount, non-ASCII or empty tick, unknown op). Dropped
    /// from state; the caller logs the reason at debug level.
    Malformed(&'static str),
    /// A valid inscription ready for the acceptance state machine.
    Valid(Krc20Inscription),
}

/// Raw shape of the envelope before validation. Every operational field
/// is optional here because validation depends on `op`; missing-field
/// rules are enforced in [`parse_krc20_inscription`].
#[derive(Deserialize)]
struct RawEnvelope {
    p: Option<String>,
    op: Option<String>,
    tick: Option<String>,
    max: Option<String>,
    lim: Option<String>,
    amt: Option<String>,
    to: Option<String>,
}

/// Parse a transaction payload as a legacy KRC-20 inscription.
///
/// Returns [`Krc20Parse::NotKrc20`] when the payload is not a KRC-20
/// envelope (not UTF-8 JSON, or `p` is absent / not `"krc-20"`), so the
/// indexer can skip the overwhelming majority of non-KRC-20 transactions
/// without noise. Returns [`Krc20Parse::Malformed`] when the envelope
/// claims to be KRC-20 but violates an acceptance precondition.
pub fn parse_krc20_inscription(payload: &[u8]) -> Krc20Parse {
    let env: RawEnvelope = match serde_json::from_slice(payload) {
        Ok(env) => env,
        Err(_) => return Krc20Parse::NotKrc20,
    };

    // The protocol tag gates everything: anything that doesn't claim to
    // be KRC-20 is none of our business and is ignored silently.
    if env.p.as_deref() != Some("krc-20") {
        return Krc20Parse::NotKrc20;
    }

    let tick_raw = match env.tick {
        Some(tick) => tick,
        None => return Krc20Parse::Malformed("missing tick"),
    };
    // Kasplex normalizes ticks to lowercase ASCII; non-ASCII ticks are
    // not valid KRC-20 and a tick must be non-empty to key the ledger.
    if tick_raw.is_empty() || !tick_raw.is_ascii() {
        return Krc20Parse::Malformed("tick must be non-empty ASCII");
    }
    let tick = tick_raw.to_ascii_lowercase();

    let op = match env.op.as_deref() {
        Some("deploy") => {
            let max = match parse_amount(env.max.as_deref()) {
                Some(max) => max,
                None => return Krc20Parse::Malformed("deploy requires a numeric max"),
            };
            let lim = match parse_amount(env.lim.as_deref()) {
                Some(lim) => lim,
                None => return Krc20Parse::Malformed("deploy requires a numeric lim"),
            };
            Krc20Op::Deploy { max, lim }
        }
        Some("mint") => match parse_amount(env.amt.as_deref()) {
            Some(amt) => Krc20Op::Mint { amt },
            None => return Krc20Parse::Malformed("mint requires a numeric amt"),
        },
        Some("transfer") => {
            let amt = match parse_amount(env.amt.as_deref()) {
                Some(amt) => amt,
                None => return Krc20Parse::Malformed("transfer requires a numeric amt"),
            };
            let to = match env.to {
                Some(to) if !to.is_empty() => to,
                _ => return Krc20Parse::Malformed("transfer requires a recipient"),
            };
            Krc20Op::Transfer { amt, to }
        }
        Some("burn") => match parse_amount(env.amt.as_deref()) {
            Some(amt) => Krc20Op::Burn { amt },
            None => return Krc20Parse::Malformed("burn requires a numeric amt"),
        },
        _ => return Krc20Parse::Malformed("unknown or missing op"),
    };

    Krc20Parse::Valid(Krc20Inscription { tick, tick_raw, op })
}

/// Parse a KRC-20 amount: a decimal u64 string with no sign, whitespace,
/// or other decoration. Returns `None` for absent or non-numeric values
/// so the caller can reject the envelope as malformed.
fn parse_amount(value: Option<&str>) -> Option<u64> {
    let value = value?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse::<u64>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(json: &str) -> Krc20Parse {
        parse_krc20_inscription(json.as_bytes())
    }

    #[test]
    fn non_json_payload_is_not_krc20() {
        assert_eq!(
            parse_krc20_inscription(b"not json at all"),
            Krc20Parse::NotKrc20
        );
    }

    #[test]
    fn json_without_krc20_protocol_is_not_krc20() {
        assert_eq!(
            parse(r#"{"p":"krc-721","op":"mint"}"#),
            Krc20Parse::NotKrc20
        );
        assert_eq!(
            parse(r#"{"op":"mint","tick":"TEST"}"#),
            Krc20Parse::NotKrc20
        );
    }

    #[test]
    fn deploy_parses_max_and_lim_and_normalizes_tick() {
        let got =
            parse(r#"{"p":"krc-20","op":"deploy","tick":"Test","max":"21000000","lim":"1000"}"#);
        assert_eq!(
            got,
            Krc20Parse::Valid(Krc20Inscription {
                tick: "test".to_owned(),
                tick_raw: "Test".to_owned(),
                op: Krc20Op::Deploy {
                    max: 21_000_000,
                    lim: 1_000
                },
            })
        );
    }

    #[test]
    fn mint_transfer_burn_parse_their_amounts() {
        assert_eq!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"500"}"#),
            Krc20Parse::Valid(Krc20Inscription {
                tick: "test".to_owned(),
                tick_raw: "TEST".to_owned(),
                op: Krc20Op::Mint { amt: 500 },
            })
        );
        assert_eq!(
            parse(r#"{"p":"krc-20","op":"transfer","tick":"TEST","amt":"5","to":"kaspa:qabc"}"#),
            Krc20Parse::Valid(Krc20Inscription {
                tick: "test".to_owned(),
                tick_raw: "TEST".to_owned(),
                op: Krc20Op::Transfer {
                    amt: 5,
                    to: "kaspa:qabc".to_owned()
                },
            })
        );
        assert_eq!(
            parse(r#"{"p":"krc-20","op":"burn","tick":"TEST","amt":"9"}"#),
            Krc20Parse::Valid(Krc20Inscription {
                tick: "test".to_owned(),
                tick_raw: "TEST".to_owned(),
                op: Krc20Op::Burn { amt: 9 },
            })
        );
    }

    #[test]
    fn unknown_op_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"frobnicate","tick":"TEST"}"#),
            Krc20Parse::Malformed(_)
        ));
    }

    #[test]
    fn non_numeric_amount_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"5.5"}"#),
            Krc20Parse::Malformed(_)
        ));
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"-1"}"#),
            Krc20Parse::Malformed(_)
        ));
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"0x10"}"#),
            Krc20Parse::Malformed(_)
        ));
    }

    #[test]
    fn transfer_without_recipient_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"transfer","tick":"TEST","amt":"5"}"#),
            Krc20Parse::Malformed(_)
        ));
    }

    #[test]
    fn deploy_missing_a_numeric_field_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"deploy","tick":"TEST","max":"100"}"#),
            Krc20Parse::Malformed(_)
        ));
    }

    #[test]
    fn non_ascii_or_empty_tick_is_malformed() {
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"tëst","amt":"1"}"#),
            Krc20Parse::Malformed(_)
        ));
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"","amt":"1"}"#),
            Krc20Parse::Malformed(_)
        ));
    }

    #[test]
    fn amount_at_u64_ceiling_parses_but_overflow_is_malformed() {
        assert_eq!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"18446744073709551615"}"#),
            Krc20Parse::Valid(Krc20Inscription {
                tick: "test".to_owned(),
                tick_raw: "TEST".to_owned(),
                op: Krc20Op::Mint { amt: u64::MAX },
            })
        );
        // One past u64::MAX: all-digits but does not fit, so rejected.
        assert!(matches!(
            parse(r#"{"p":"krc-20","op":"mint","tick":"TEST","amt":"18446744073709551616"}"#),
            Krc20Parse::Malformed(_)
        ));
    }
}
