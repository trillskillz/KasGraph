//! Rebuild legacy KRC-20/721 in-memory ledger state from journaled op rows.
//!
//! Legacy KRC-20/721 state is a pure function of the accepted op stream
//! (`KRC20_KRC721_REFERENCE.md:54`), so on startup and after a reorg unwind
//! the node reconstructs the ledger by replaying the surviving journal rows
//! in acceptance order. `kasgraph_store::Store::fetch_krc20_legacy_ops_ordered`
//! (and the KRC-721 sibling) supply those rows already ordered; this module
//! is the inverse of the inscription parser — it turns a stored
//! [`Krc20LegacyOpRecord`] / [`Krc721LegacyOpRecord`] back into the
//! [`Krc20Inscription`] / [`Krc721Inscription`] that `*Ledger::replay`
//! consumes.
//!
//! The op-relevant columns (`op`, `token_id`/`amount`, `recipient`, `uri`,
//! `max`, `lim`) were written from a `Valid` parse result, so a well-formed
//! journal always reconstructs cleanly; the [`Result`] guards against a row
//! that a future bug stored malformed (an unknown `op` string or a missing /
//! non-decimal numeric column) rather than silently fabricating an op.

#![allow(dead_code)]

use kasgraph_detectors::{
    Krc20Inscription, Krc20Ledger, Krc20Op, Krc721Inscription, Krc721Ledger, Krc721Op,
};
use kasgraph_store::{Krc20LegacyOpRecord, Krc721LegacyOpRecord};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum LegacyReconstructError {
    #[error("journaled op `{0}` is not a known legacy {1} operation")]
    UnknownOp(String, &'static str),
    #[error("journaled `{op}` row is missing its `{column}` column")]
    MissingColumn { op: String, column: &'static str },
    #[error("journaled `{column}` column `{value}` is not a decimal u64")]
    InvalidU64 { column: &'static str, value: String },
}

fn required<'a>(
    value: &'a Option<String>,
    op: &str,
    column: &'static str,
) -> Result<&'a str, LegacyReconstructError> {
    value
        .as_deref()
        .ok_or_else(|| LegacyReconstructError::MissingColumn {
            op: op.to_string(),
            column,
        })
}

fn parse_u64(value: &str, column: &'static str) -> Result<u64, LegacyReconstructError> {
    value
        .parse::<u64>()
        .map_err(|_| LegacyReconstructError::InvalidU64 {
            column,
            value: value.to_string(),
        })
}

/// Reconstruct the inscription a legacy KRC-20 journal row recorded.
pub fn krc20_inscription_from_record(
    record: &Krc20LegacyOpRecord,
) -> Result<Krc20Inscription, LegacyReconstructError> {
    let op = match record.op.as_str() {
        "deploy" => Krc20Op::Deploy {
            max: parse_u64(
                required(&record.max_supply, "deploy", "max_supply")?,
                "max_supply",
            )?,
            lim: parse_u64(
                required(&record.mint_limit, "deploy", "mint_limit")?,
                "mint_limit",
            )?,
        },
        "mint" => Krc20Op::Mint {
            amt: parse_u64(required(&record.amount, "mint", "amount")?, "amount")?,
        },
        "transfer" => Krc20Op::Transfer {
            amt: parse_u64(required(&record.amount, "transfer", "amount")?, "amount")?,
            to: required(&record.recipient, "transfer", "recipient")?.to_string(),
        },
        "burn" => Krc20Op::Burn {
            amt: parse_u64(required(&record.amount, "burn", "amount")?, "amount")?,
        },
        other => {
            return Err(LegacyReconstructError::UnknownOp(
                other.to_string(),
                "KRC-20",
            ))
        }
    };
    Ok(Krc20Inscription {
        tick: record.tick.clone(),
        tick_raw: record.tick_raw.clone(),
        op,
    })
}

/// Reconstruct the inscription a legacy KRC-721 journal row recorded.
pub fn krc721_inscription_from_record(
    record: &Krc721LegacyOpRecord,
) -> Result<Krc721Inscription, LegacyReconstructError> {
    let op = match record.op.as_str() {
        "deploy" => Krc721Op::Deploy {
            max: parse_u64(
                required(&record.max_supply, "deploy", "max_supply")?,
                "max_supply",
            )?,
        },
        "mint" => Krc721Op::Mint {
            id: parse_u64(required(&record.token_id, "mint", "token_id")?, "token_id")?,
            uri: required(&record.metadata_uri, "mint", "metadata_uri")?.to_string(),
        },
        "transfer" => Krc721Op::Transfer {
            id: parse_u64(
                required(&record.token_id, "transfer", "token_id")?,
                "token_id",
            )?,
            to: required(&record.recipient, "transfer", "recipient")?.to_string(),
        },
        "burn" => Krc721Op::Burn {
            id: parse_u64(required(&record.token_id, "burn", "token_id")?, "token_id")?,
        },
        other => {
            return Err(LegacyReconstructError::UnknownOp(
                other.to_string(),
                "KRC-721",
            ))
        }
    };
    Ok(Krc721Inscription {
        tick: record.tick.clone(),
        tick_raw: record.tick_raw.clone(),
        op,
    })
}

/// Rebuild a legacy KRC-20 ledger by replaying journaled rows in the order
/// `fetch_krc20_legacy_ops_ordered` returns them. The row's `sender` is the
/// already-resolved op sender, so replay needs no address resolution.
pub fn replay_krc20_from_records(
    records: &[Krc20LegacyOpRecord],
) -> Result<Krc20Ledger, LegacyReconstructError> {
    let mut ops = Vec::with_capacity(records.len());
    for record in records {
        ops.push((
            krc20_inscription_from_record(record)?,
            record.sender.clone(),
        ));
    }
    Ok(Krc20Ledger::replay(
        ops.iter().map(|(ins, sender)| (ins, sender.as_str())),
    ))
}

/// Rebuild a legacy KRC-721 ledger by replaying journaled rows in order (the
/// NFT parallel of [`replay_krc20_from_records`]).
pub fn replay_krc721_from_records(
    records: &[Krc721LegacyOpRecord],
) -> Result<Krc721Ledger, LegacyReconstructError> {
    let mut ops = Vec::with_capacity(records.len());
    for record in records {
        ops.push((
            krc721_inscription_from_record(record)?,
            record.sender.clone(),
        ));
    }
    Ok(Krc721Ledger::replay(
        ops.iter().map(|(ins, sender)| (ins, sender.as_str())),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kasgraph_store::SubgraphId;

    fn subgraph() -> SubgraphId {
        SubgraphId::new("krc20_mainnet_v1").unwrap()
    }

    fn krc20_record(
        op: &str,
        amount: Option<&str>,
        recipient: Option<&str>,
        max_supply: Option<&str>,
        mint_limit: Option<&str>,
    ) -> Krc20LegacyOpRecord {
        Krc20LegacyOpRecord {
            subgraph: subgraph(),
            tick: "tick".to_string(),
            tick_raw: "TICK".to_string(),
            accepting_block_hash: "block".to_string(),
            seq: 0,
            accepting_daa_score: 1,
            tx_hash: "tx".to_string(),
            op: op.to_string(),
            sender: "kaspa:sender".to_string(),
            recipient: recipient.map(str::to_string),
            amount: amount.map(str::to_string),
            max_supply: max_supply.map(str::to_string),
            mint_limit: mint_limit.map(str::to_string),
        }
    }

    fn krc721_record(
        op: &str,
        token_id: Option<&str>,
        recipient: Option<&str>,
        metadata_uri: Option<&str>,
        max_supply: Option<&str>,
    ) -> Krc721LegacyOpRecord {
        Krc721LegacyOpRecord {
            subgraph: subgraph(),
            tick: "coll".to_string(),
            tick_raw: "COLL".to_string(),
            accepting_block_hash: "block".to_string(),
            seq: 0,
            accepting_daa_score: 1,
            tx_hash: "tx".to_string(),
            op: op.to_string(),
            sender: "kaspa:sender".to_string(),
            token_id: token_id.map(str::to_string),
            recipient: recipient.map(str::to_string),
            metadata_uri: metadata_uri.map(str::to_string),
            max_supply: max_supply.map(str::to_string),
        }
    }

    #[test]
    fn krc20_each_op_reconstructs_to_its_inscription() {
        assert_eq!(
            krc20_inscription_from_record(&krc20_record(
                "deploy",
                None,
                None,
                Some("21000000"),
                Some("1000")
            ))
            .unwrap()
            .op,
            Krc20Op::Deploy {
                max: 21_000_000,
                lim: 1_000
            }
        );
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("mint", Some("500"), None, None, None))
                .unwrap()
                .op,
            Krc20Op::Mint { amt: 500 }
        );
        assert_eq!(
            krc20_inscription_from_record(&krc20_record(
                "transfer",
                Some("9"),
                Some("kaspa:bob"),
                None,
                None
            ))
            .unwrap()
            .op,
            Krc20Op::Transfer {
                amt: 9,
                to: "kaspa:bob".to_string()
            }
        );
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("burn", Some("1"), None, None, None))
                .unwrap()
                .op,
            Krc20Op::Burn { amt: 1 }
        );
    }

    #[test]
    fn krc20_preserves_tick_and_tick_raw() {
        let ins = krc20_inscription_from_record(&krc20_record("mint", Some("1"), None, None, None))
            .unwrap();
        assert_eq!(ins.tick, "tick");
        assert_eq!(ins.tick_raw, "TICK");
    }

    #[test]
    fn krc20_u64_amount_beyond_i64_max_round_trips() {
        // The whole reason amounts are stored as TEXT: u64 > i64::MAX.
        let big = (i64::MAX as u64 + 1).to_string();
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("mint", Some(&big), None, None, None))
                .unwrap()
                .op,
            Krc20Op::Mint {
                amt: i64::MAX as u64 + 1
            }
        );
    }

    #[test]
    fn krc20_unknown_op_is_rejected() {
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("airdrop", None, None, None, None)),
            Err(LegacyReconstructError::UnknownOp(
                "airdrop".to_string(),
                "KRC-20"
            ))
        );
    }

    #[test]
    fn krc20_missing_required_column_is_rejected() {
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("mint", None, None, None, None)),
            Err(LegacyReconstructError::MissingColumn {
                op: "mint".to_string(),
                column: "amount"
            })
        );
    }

    #[test]
    fn krc20_non_decimal_column_is_rejected() {
        assert_eq!(
            krc20_inscription_from_record(&krc20_record("mint", Some("0x10"), None, None, None)),
            Err(LegacyReconstructError::InvalidU64 {
                column: "amount",
                value: "0x10".to_string()
            })
        );
    }

    #[test]
    fn krc721_each_op_reconstructs_to_its_inscription() {
        assert_eq!(
            krc721_inscription_from_record(&krc721_record(
                "deploy",
                None,
                None,
                None,
                Some("10000")
            ))
            .unwrap()
            .op,
            Krc721Op::Deploy { max: 10_000 }
        );
        assert_eq!(
            krc721_inscription_from_record(&krc721_record(
                "mint",
                Some("7"),
                None,
                Some("ipfs://meta/7"),
                None
            ))
            .unwrap()
            .op,
            Krc721Op::Mint {
                id: 7,
                uri: "ipfs://meta/7".to_string()
            }
        );
        assert_eq!(
            krc721_inscription_from_record(&krc721_record(
                "transfer",
                Some("7"),
                Some("kaspa:bob"),
                None,
                None
            ))
            .unwrap()
            .op,
            Krc721Op::Transfer {
                id: 7,
                to: "kaspa:bob".to_string()
            }
        );
        assert_eq!(
            krc721_inscription_from_record(&krc721_record("burn", Some("7"), None, None, None))
                .unwrap()
                .op,
            Krc721Op::Burn { id: 7 }
        );
    }

    #[test]
    fn replay_krc20_rebuilds_balances_from_the_row_stream() {
        // deploy → mint 500 to sender → transfer 200 to bob.
        let records = vec![
            krc20_record("deploy", None, None, Some("1000"), Some("1000")),
            krc20_record("mint", Some("500"), None, None, None),
            krc20_record("transfer", Some("200"), Some("kaspa:bob"), None, None),
        ];
        let ledger = replay_krc20_from_records(&records).unwrap();
        let token = ledger.token("tick").unwrap();
        assert_eq!(token.balances.get("kaspa:sender").copied(), Some(300));
        assert_eq!(token.balances.get("kaspa:bob").copied(), Some(200));
        assert_eq!(token.minted, 500);
    }

    #[test]
    fn replay_krc721_rebuilds_ownership_from_the_row_stream() {
        // deploy → mint id 1 to sender → transfer id 1 to bob.
        let records = vec![
            krc721_record("deploy", None, None, None, Some("100")),
            krc721_record("mint", Some("1"), None, Some("ipfs://1"), None),
            krc721_record("transfer", Some("1"), Some("kaspa:bob"), None, None),
        ];
        let ledger = replay_krc721_from_records(&records).unwrap();
        assert_eq!(ledger.owner_of("coll", 1), Some("kaspa:bob"));
    }

    #[test]
    fn replay_propagates_a_malformed_row() {
        let records = vec![krc20_record("airdrop", None, None, None, None)];
        assert!(replay_krc20_from_records(&records).is_err());
    }
}
