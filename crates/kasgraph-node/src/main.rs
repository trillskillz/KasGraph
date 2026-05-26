//! kasgraph-node — the Rust indexer binary.
//!
//! Subscribes to the Kaspa RPC layer (`kasgraph-rpc`), routes blocks
//! through the detector pipeline (`kasgraph-detectors`), dispatches
//! typed events into subgraph WASM mappings (`kasgraph-mapping`),
//! persists results through `kasgraph-store`, emits POI checkpoints
//! (`kasgraph-poi`), and tees real-time events into KasStream
//! (`kasgraph-stream`).
//!
//! Current state: scaffold with the first real RPC-to-store wiring plus
//! a minimal Phase 2.3 ingestion state model.
//! The node can now:
//!   - initialize the shared store migrations
//!   - ensure a subgraph schema exists
//!   - fetch one or more blocks through `kasgraph-rpc` when RPC env is configured
//!   - process minimal live-style notifications (`BlockAdded`, `VirtualChainChanged`, `RecoveryRequired`)
//!   - buffer probabilistic blocks separately from committed blocks
//!   - promote buffered blocks when a finalized block arrives
//!   - rollback conflicting probabilistic ranges before replay
//!   - request a small recovery replay range from configured hashes
//!   - compute scaffold POI checkpoints for committed blocks only
//!   - persist RPC block-audit rows and POI checkpoints
//! Full ingestion and subscription semantics land in Phase 2.3–2.8.

use std::{collections::BTreeMap, env, time::Duration};

use anyhow::{Context, Result};
use kasgraph_poi::{PoiHash, compute_poi, poi_hex};
use kasgraph_rpc::{
    ChainNotification, IngestedBlock, MultiRpcClient, RpcClientConfig, RpcEndpoint,
    parse_notifications_jsonl,
};
use kasgraph_store::{PoiCheckpoint, RpcBlockAuditRecord, Store, SubgraphId};
use tracing::{info, warn};

const DEFAULT_SUBGRAPH: &str = "kasgraph_scaffold";
const DEFAULT_BLOCK_HASH: &str = "scaffold-block-0001";
const DEFAULT_SERVED_BY: &str = "bootstrap";
const DEFAULT_PRIMARY_RPC_LABEL: &str = "primary";
const DEFAULT_RPC_TIMEOUT_MS: u64 = 1_500;
const DEFAULT_HEALTH_PROBE_INTERVAL_MS: u64 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
struct BootstrapBlock {
    hash: String,
    daa_score: i64,
    blue_score: i64,
    served_by: String,
    is_finalized: bool,
    canonical_entity_bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RpcConfig {
    primary_url: String,
    primary_label: String,
    timeout_ms: u64,
    health_probe_interval_ms: u64,
    backup_urls: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RecoveryConfig {
    removed_block_hashes: Vec<String>,
    recovery_block_hashes: Vec<String>,
    recovery_range: Option<(u64, u64)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotificationStreamConfig {
    jsonl: Option<String>,
    ws_url: Option<String>,
    served_by: String,
    max_messages: usize,
    idle_timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NodeConfig {
    database_url: Option<String>,
    subgraph: String,
    block_hashes: Vec<String>,
    rpc: Option<RpcConfig>,
    recovery: RecoveryConfig,
    notification_stream: Option<NotificationStreamConfig>,
    bootstrap_block: BootstrapBlock,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct CommittedBlockWrite {
    block: BootstrapBlock,
    poi_hash: PoiHash,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct IngestionState {
    committed: BTreeMap<i64, BootstrapBlock>,
    probabilistic: BTreeMap<i64, BootstrapBlock>,
    prior_poi: PoiHash,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct IngestionTransition {
    committed_writes: Vec<CommittedBlockWrite>,
    rolled_back_probabilistic: Vec<BootstrapBlock>,
    recovery_requested: Option<(u64, u64)>,
}

impl NodeConfig {
    fn from_env() -> Self {
        Self {
            database_url: env::var("KASGRAPH_DATABASE_URL").ok(),
            subgraph: env::var("KASGRAPH_SUBGRAPH").unwrap_or_else(|_| DEFAULT_SUBGRAPH.to_owned()),
            block_hashes: env::var("KASGRAPH_BLOCK_HASHES")
                .ok()
                .map(|value| parse_csv_env(&value))
                .filter(|values| !values.is_empty())
                .unwrap_or_else(|| {
                    vec![
                        env::var("KASGRAPH_BLOCK_HASH")
                            .unwrap_or_else(|_| DEFAULT_BLOCK_HASH.to_owned()),
                    ]
                }),
            rpc: env::var("KASGRAPH_RPC_PRIMARY_URL").ok().map(|primary_url| RpcConfig {
                primary_url,
                primary_label: env::var("KASGRAPH_RPC_PRIMARY_LABEL")
                    .unwrap_or_else(|_| DEFAULT_PRIMARY_RPC_LABEL.to_owned()),
                timeout_ms: env::var("KASGRAPH_RPC_TIMEOUT_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(DEFAULT_RPC_TIMEOUT_MS),
                health_probe_interval_ms: env::var("KASGRAPH_RPC_HEALTH_PROBE_INTERVAL_MS")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(DEFAULT_HEALTH_PROBE_INTERVAL_MS),
                backup_urls: env::var("KASGRAPH_RPC_BACKUP_URLS")
                    .ok()
                    .map(|value| parse_csv_env(&value))
                    .unwrap_or_default(),
            }),
            recovery: RecoveryConfig {
                removed_block_hashes: env::var("KASGRAPH_REMOVED_BLOCK_HASHES")
                    .ok()
                    .map(|value| parse_csv_env(&value))
                    .unwrap_or_default(),
                recovery_block_hashes: env::var("KASGRAPH_RECOVERY_BLOCK_HASHES")
                    .ok()
                    .map(|value| parse_csv_env(&value))
                    .unwrap_or_default(),
                recovery_range: parse_recovery_range(env::var("KASGRAPH_RECOVERY_RANGE").ok().as_deref()),
            },
            notification_stream: {
                let jsonl = env::var("KASGRAPH_NOTIFICATION_JSONL").ok();
                let ws_url = env::var("KASGRAPH_NOTIFICATION_WS_URL").ok();
                match (jsonl, ws_url) {
                    (None, None) => None,
                    (jsonl, ws_url) => Some(NotificationStreamConfig {
                        jsonl,
                        ws_url,
                        served_by: env::var("KASGRAPH_NOTIFICATION_SOURCE_LABEL")
                            .unwrap_or_else(|_| "stream".to_owned()),
                        max_messages: env::var("KASGRAPH_NOTIFICATION_MAX_MESSAGES")
                            .ok()
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(64),
                        idle_timeout_ms: env::var("KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS")
                            .ok()
                            .and_then(|value| value.parse().ok())
                            .unwrap_or(0),
                    }),
                }
            },
            bootstrap_block: BootstrapBlock {
                hash: env::var("KASGRAPH_BOOTSTRAP_BLOCK_HASH")
                    .unwrap_or_else(|_| DEFAULT_BLOCK_HASH.to_owned()),
                daa_score: env::var("KASGRAPH_BOOTSTRAP_DAA_SCORE")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(1),
                blue_score: env::var("KASGRAPH_BOOTSTRAP_BLUE_SCORE")
                    .ok()
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(1),
                served_by: env::var("KASGRAPH_BOOTSTRAP_SERVED_BY")
                    .unwrap_or_else(|_| DEFAULT_SERVED_BY.to_owned()),
                is_finalized: env::var("KASGRAPH_BOOTSTRAP_FINALIZED")
                    .ok()
                    .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "True"))
                    .unwrap_or(true),
                canonical_entity_bytes: env::var("KASGRAPH_BOOTSTRAP_ENTITY_BYTES")
                    .map(|value| value.into_bytes())
                    .unwrap_or_else(|_| b"scaffold-entity-state".to_vec()),
            },
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config = NodeConfig::from_env();

    info!(version = env!("CARGO_PKG_VERSION"), ?config, "kasgraph-node bootstrap");
    info!("crates wired: rpc, store, detectors, mapping, poi, stream");

    match &config.database_url {
        Some(database_url) => {
            persist_bootstrap_state(database_url, &config)
                .await
                .context("failed to persist bootstrap state")?;
        }
        None => {
            warn!(
                "KASGRAPH_DATABASE_URL not set; skipping migrations and persistence bootstrap"
            );
        }
    }

    info!("phase 2 ingestion loop pending — see PLAN.md Phase 2.3–2.8");
    Ok(())
}

async fn persist_bootstrap_state(database_url: &str, config: &NodeConfig) -> Result<()> {
    let store = Store::connect(database_url)
        .await
        .with_context(|| format!("connecting to store at {database_url}"))?;
    store.migrate().await.context("running shared store migrations")?;

    let subgraph = SubgraphId::new(config.subgraph.clone()).context("validating subgraph schema id")?;
    store
        .ensure_subgraph_schema(&subgraph)
        .await
        .with_context(|| format!("ensuring schema {} exists", subgraph.schema_name()))?;

    let rpc_client = config.rpc.as_ref().map(build_rpc_client);
    let notifications = build_notifications(config, rpc_client.as_ref()).await?;
    let mut ingestion = IngestionState::default();

    for notification in notifications {
        let transition = ingestion
            .apply_notification(notification)
            .context("applying ingestion notification")?;

        for rolled_back in transition.rolled_back_probabilistic {
            warn!(
                block_hash = rolled_back.hash,
                daa_score = rolled_back.daa_score,
                "rolled back probabilistic block before replay"
            );
        }

        if let Some((from_daa, to_daa)) = transition.recovery_requested {
            info!(from_daa, to_daa, "recovery requested by ingestion state");
        }

        for committed in transition.committed_writes {
            let checkpoint = PoiCheckpoint {
                subgraph: subgraph.clone(),
                block_daa_score: committed.block.daa_score,
                poi_hash: committed.poi_hash,
            };
            let audit = RpcBlockAuditRecord {
                block_hash: committed.block.hash.clone(),
                daa_score: committed.block.daa_score,
                served_by: committed.block.served_by.clone(),
            };

            store
                .insert_poi_checkpoint(&checkpoint)
                .await
                .context("writing POI checkpoint")?;
            store
                .insert_rpc_block_audit(&audit)
                .await
                .context("writing RPC audit record")?;

            info!(
                subgraph = subgraph.schema_name(),
                block_hash = audit.block_hash,
                daa_score = checkpoint.block_daa_score,
                poi = poi_hex(&checkpoint.poi_hash),
                served_by = audit.served_by,
                finalized = committed.block.is_finalized,
                "persisted committed checkpoint"
            );
        }
    }

    info!(
        committed_blocks = ingestion.committed.len(),
        probabilistic_blocks = ingestion.probabilistic.len(),
        "ingestion pass complete"
    );

    Ok(())
}

async fn build_notifications(
    config: &NodeConfig,
    rpc_client: Option<&MultiRpcClient>,
) -> Result<Vec<ChainNotification>> {
    let mut notifications = Vec::new();

    if let Some(stream) = &config.notification_stream {
        if let Some(jsonl) = &stream.jsonl {
            return parse_notifications_jsonl(jsonl, &stream.served_by)
                .context("parsing notification JSONL stream");
        }

        if let Some(ws_url) = &stream.ws_url {
            if let Some(client) = rpc_client {
                return client
                    .read_notifications_ws(
                        ws_url,
                        &stream.served_by,
                        stream.max_messages,
                        stream.idle_timeout_ms,
                    )
                    .await
                    .with_context(|| format!("reading notification websocket stream from {ws_url}"));
            }

            let bootstrap_client = build_rpc_client(&RpcConfig {
                primary_url: ws_url.clone(),
                primary_label: stream.served_by.clone(),
                timeout_ms: DEFAULT_RPC_TIMEOUT_MS,
                health_probe_interval_ms: DEFAULT_HEALTH_PROBE_INTERVAL_MS,
                backup_urls: Vec::new(),
            });
            return bootstrap_client
                .read_notifications_ws(
                    ws_url,
                    &stream.served_by,
                    stream.max_messages,
                    stream.idle_timeout_ms,
                )
                .await
                .with_context(|| format!("reading notification websocket stream from {ws_url}"));
        }
    }

    if !config.recovery.removed_block_hashes.is_empty() || !config.block_hashes.is_empty() {
        let blocks = fetch_or_fallback_blocks(config, rpc_client).await?;
        if blocks.len() == 1 && config.recovery.removed_block_hashes.is_empty() {
            notifications.push(ChainNotification::BlockAdded(block_to_rpc(&blocks[0])));
        } else {
            notifications.push(ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes: config.recovery.removed_block_hashes.clone(),
                added_chain_blocks: blocks.iter().map(block_to_rpc).collect(),
            });
        }
    }

    if let Some((from_daa, to_daa)) = config.recovery.recovery_range {
        notifications.push(ChainNotification::RecoveryRequired {
            from_daa_score: from_daa,
            to_daa_score: to_daa,
            reason: "env-configured recovery replay".to_owned(),
        });

        if let Some(client) = rpc_client {
            if !config.recovery.recovery_block_hashes.is_empty() {
                notifications.push(
                    client
                        .recover_blocks_by_hashes(
                            &config.recovery.recovery_block_hashes,
                            from_daa,
                            to_daa,
                        )
                        .await
                        .context("recovering blocks for replay range")?,
                );
            }
        }
    }

    Ok(notifications)
}

async fn fetch_or_fallback_blocks(
    config: &NodeConfig,
    rpc_client: Option<&MultiRpcClient>,
) -> Result<Vec<BootstrapBlock>> {
    if let Some(client) = rpc_client {
        let fetched = client
            .fetch_blocks(&config.block_hashes)
            .await
            .context("fetching block batch via RPC")?;
        return Ok(fetched.into_iter().map(block_from_rpc).collect());
    }

    warn!("KASGRAPH_RPC_PRIMARY_URL not set; using scaffold bootstrap block data");
    Ok(vec![config.bootstrap_block.clone()])
}

fn build_rpc_client(config: &RpcConfig) -> MultiRpcClient {
    MultiRpcClient::new(RpcClientConfig {
        primary: RpcEndpoint {
            label: config.primary_label.clone(),
            url: config.primary_url.clone(),
            timeout: Duration::from_millis(config.timeout_ms),
        },
        backups: config
            .backup_urls
            .iter()
            .enumerate()
            .map(|(index, url)| RpcEndpoint {
                label: format!("backup-{}", index + 1),
                url: url.clone(),
                timeout: Duration::from_millis(config.timeout_ms),
            })
            .collect(),
        health_probe_interval: Duration::from_millis(config.health_probe_interval_ms),
    })
}

impl IngestionState {
    fn apply_notification(&mut self, notification: ChainNotification) -> Result<IngestionTransition> {
        match notification {
            ChainNotification::BlockAdded(block) => self.apply_block(block_from_rpc(block)),
            ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes,
                added_chain_blocks,
            } => {
                let mut rolled_back_probabilistic = self.remove_probabilistic_by_hashes(&removed_chain_block_hashes);
                let mut committed_writes = Vec::new();

                for block in added_chain_blocks {
                    let transition = self.apply_block(block_from_rpc(block))?;
                    rolled_back_probabilistic.extend(transition.rolled_back_probabilistic);
                    committed_writes.extend(transition.committed_writes);
                }

                Ok(IngestionTransition {
                    committed_writes,
                    rolled_back_probabilistic,
                    recovery_requested: None,
                })
            }
            ChainNotification::RecoveryRequired {
                from_daa_score,
                to_daa_score,
                ..
            } => {
                let rolled_back_probabilistic = self.remove_probabilistic_in_range(
                    from_daa_score as i64,
                    to_daa_score as i64,
                );
                Ok(IngestionTransition {
                    committed_writes: Vec::new(),
                    rolled_back_probabilistic,
                    recovery_requested: Some((from_daa_score, to_daa_score)),
                })
            }
        }
    }

    fn apply_block(&mut self, block: BootstrapBlock) -> Result<IngestionTransition> {
        let mut rolled_back_probabilistic = Vec::new();

        if let Some(existing) = self.committed.get(&block.daa_score) {
            if existing.hash == block.hash {
                return Ok(IngestionTransition {
                    committed_writes: Vec::new(),
                    rolled_back_probabilistic,
                    recovery_requested: None,
                });
            }

            warn!(
                existing_hash = existing.hash,
                incoming_hash = block.hash,
                daa_score = block.daa_score,
                "conflict against committed block detected; ignoring incoming block until deeper reorg support lands"
            );
            return Ok(IngestionTransition {
                committed_writes: Vec::new(),
                rolled_back_probabilistic,
                recovery_requested: None,
            });
        }

        let conflicting_scores: Vec<i64> = self
            .probabilistic
            .range(block.daa_score..)
            .filter_map(|(score, existing)| (existing.hash != block.hash).then_some(*score))
            .collect();
        for score in conflicting_scores {
            if let Some(removed) = self.probabilistic.remove(&score) {
                rolled_back_probabilistic.push(removed);
            }
        }

        if !block.is_finalized {
            self.probabilistic.insert(block.daa_score, block);
            return Ok(IngestionTransition {
                committed_writes: Vec::new(),
                rolled_back_probabilistic,
                recovery_requested: None,
            });
        }

        self.probabilistic.insert(block.daa_score, block);

        let promotable_scores: Vec<i64> = self
            .probabilistic
            .range(..=self.highest_finalized_daa())
            .map(|(score, _)| *score)
            .collect();

        let mut committed_writes = Vec::new();
        for score in promotable_scores {
            if let Some(probabilistic_block) = self.probabilistic.remove(&score) {
                let poi_hash = compute_poi(&self.prior_poi, &probabilistic_block.canonical_entity_bytes)
                    .context("computing committed block POI")?;
                self.prior_poi = poi_hash;
                self.committed.insert(score, probabilistic_block.clone());
                committed_writes.push(CommittedBlockWrite {
                    block: probabilistic_block,
                    poi_hash,
                });
            }
        }

        Ok(IngestionTransition {
            committed_writes,
            rolled_back_probabilistic,
            recovery_requested: None,
        })
    }

    fn remove_probabilistic_by_hashes(&mut self, hashes: &[String]) -> Vec<BootstrapBlock> {
        let mut removed = Vec::new();
        let matching_scores: Vec<i64> = self
            .probabilistic
            .iter()
            .filter_map(|(score, block)| hashes.contains(&block.hash).then_some(*score))
            .collect();
        for score in matching_scores {
            if let Some(block) = self.probabilistic.remove(&score) {
                removed.push(block);
            }
        }
        removed
    }

    fn remove_probabilistic_in_range(&mut self, from_daa: i64, to_daa: i64) -> Vec<BootstrapBlock> {
        let scores: Vec<i64> = self.probabilistic.range(from_daa..=to_daa).map(|(score, _)| *score).collect();
        let mut removed = Vec::new();
        for score in scores {
            if let Some(block) = self.probabilistic.remove(&score) {
                removed.push(block);
            }
        }
        removed
    }

    fn highest_finalized_daa(&self) -> i64 {
        self.probabilistic
            .iter()
            .filter_map(|(score, block)| block.is_finalized.then_some(*score))
            .max()
            .unwrap_or_default()
    }
}

fn block_from_rpc(block: IngestedBlock) -> BootstrapBlock {
    let canonical_entity_bytes = canonical_bytes_for_block(&block);
    BootstrapBlock {
        hash: block.hash.clone(),
        daa_score: block.daa_score as i64,
        blue_score: block.blue_score as i64,
        served_by: block.served_by,
        is_finalized: block.is_finalized,
        canonical_entity_bytes,
    }
}

fn block_to_rpc(block: &BootstrapBlock) -> IngestedBlock {
    IngestedBlock {
        hash: block.hash.clone(),
        daa_score: block.daa_score as u64,
        blue_score: block.blue_score as u64,
        is_finalized: block.is_finalized,
        served_by: block.served_by.clone(),
    }
}

fn canonical_bytes_for_block(block: &IngestedBlock) -> Vec<u8> {
    format!(
        "hash={}::daa={}::blue={}::finalized={}::served_by={}",
        block.hash, block.daa_score, block.blue_score, block.is_finalized, block.served_by
    )
    .into_bytes()
}

fn parse_csv_env(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_recovery_range(value: Option<&str>) -> Option<(u64, u64)> {
    let value = value?;
    let (from, to) = value.split_once(':')?;
    Some((from.trim().parse().ok()?, to.trim().parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block(hash: &str, daa_score: i64, finalized: bool) -> BootstrapBlock {
        BootstrapBlock {
            hash: hash.to_owned(),
            daa_score,
            blue_score: daa_score,
            served_by: "primary".to_owned(),
            is_finalized: finalized,
            canonical_entity_bytes: format!("state-{hash}-{daa_score}").into_bytes(),
        }
    }

    #[test]
    fn bootstrap_poi_chain_is_deterministic() {
        let mut state = IngestionState::default();
        let first = state.apply_block(block("a", 1, true)).unwrap();
        let second = state.apply_block(block("b", 2, true)).unwrap();
        assert_eq!(first.committed_writes.len(), 1);
        assert_eq!(second.committed_writes.len(), 1);
        assert_ne!(first.committed_writes[0].poi_hash, second.committed_writes[0].poi_hash);
    }

    #[test]
    fn probabilistic_blocks_buffer_until_finalized_block_arrives() {
        let mut state = IngestionState::default();
        let first = state.apply_block(block("a", 1, false)).unwrap();
        let second = state.apply_block(block("b", 2, true)).unwrap();

        assert!(first.committed_writes.is_empty());
        assert_eq!(second.committed_writes.len(), 2);
        assert_eq!(state.committed.len(), 2);
        assert!(state.probabilistic.is_empty());
    }

    #[test]
    fn conflicting_probabilistic_range_rolls_back_before_replay() {
        let mut state = IngestionState::default();
        state.apply_block(block("a", 10, false)).unwrap();
        state.apply_block(block("b", 11, false)).unwrap();

        let transition = state.apply_block(block("c", 10, true)).unwrap();
        assert_eq!(transition.rolled_back_probabilistic.len(), 2);
        assert_eq!(transition.committed_writes.len(), 1);
        assert_eq!(transition.committed_writes[0].block.hash, "c");
    }

    #[test]
    fn virtual_chain_changed_removes_probabilistic_hashes_and_replays_additions() {
        let mut state = IngestionState::default();
        state.apply_block(block("old-a", 10, false)).unwrap();
        state.apply_block(block("old-b", 11, false)).unwrap();

        let transition = state
            .apply_notification(ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes: vec!["old-a".to_owned(), "old-b".to_owned()],
                added_chain_blocks: vec![
                    block_to_rpc(&block("new-a", 10, false)),
                    block_to_rpc(&block("new-b", 11, true)),
                ],
            })
            .unwrap();

        assert_eq!(transition.rolled_back_probabilistic.len(), 2);
        assert_eq!(transition.committed_writes.len(), 2);
        assert!(state.committed.values().any(|block| block.hash == "new-a"));
        assert!(state.committed.values().any(|block| block.hash == "new-b"));
    }

    #[test]
    fn recovery_required_clears_probabilistic_range_and_requests_replay() {
        let mut state = IngestionState::default();
        state.apply_block(block("a", 5, false)).unwrap();
        state.apply_block(block("b", 6, false)).unwrap();
        state.apply_block(block("c", 7, false)).unwrap();

        let transition = state
            .apply_notification(ChainNotification::RecoveryRequired {
                from_daa_score: 6,
                to_daa_score: 7,
                reason: "gap".to_owned(),
            })
            .unwrap();

        assert_eq!(transition.rolled_back_probabilistic.len(), 2);
        assert_eq!(transition.recovery_requested, Some((6, 7)));
        assert!(state.probabilistic.values().any(|block| block.hash == "a"));
    }

    #[test]
    fn duplicate_committed_block_is_ignored() {
        let mut state = IngestionState::default();
        state.apply_block(block("a", 1, true)).unwrap();
        let transition = state.apply_block(block("a", 1, true)).unwrap();
        assert!(transition.committed_writes.is_empty());
    }

    #[test]
    fn config_defaults_are_stable() {
        let config = NodeConfig {
            database_url: None,
            subgraph: DEFAULT_SUBGRAPH.to_owned(),
            block_hashes: vec![DEFAULT_BLOCK_HASH.to_owned()],
            rpc: None,
            recovery: RecoveryConfig {
                removed_block_hashes: Vec::new(),
                recovery_block_hashes: Vec::new(),
                recovery_range: None,
            },
            notification_stream: None,
            bootstrap_block: BootstrapBlock {
                hash: DEFAULT_BLOCK_HASH.to_owned(),
                daa_score: 1,
                blue_score: 1,
                served_by: DEFAULT_SERVED_BY.to_owned(),
                is_finalized: true,
                canonical_entity_bytes: b"scaffold-entity-state".to_vec(),
            },
        };

        assert_eq!(config.subgraph, "kasgraph_scaffold");
        assert_eq!(config.bootstrap_block.served_by, "bootstrap");
    }

    #[test]
    fn block_from_rpc_maps_fields_and_builds_canonical_bytes() {
        let block = IngestedBlock {
            hash: "abc".to_owned(),
            daa_score: 42,
            blue_score: 7,
            is_finalized: true,
            served_by: "primary".to_owned(),
        };

        let mapped = block_from_rpc(block);
        assert_eq!(mapped.hash, "abc");
        assert_eq!(mapped.daa_score, 42);
        assert_eq!(mapped.blue_score, 7);
        assert_eq!(mapped.served_by, "primary");
        assert!(mapped.is_finalized);
        assert!(String::from_utf8(mapped.canonical_entity_bytes).unwrap().contains("finalized=true"));
    }

    #[test]
    fn rpc_client_builder_assigns_backup_labels() {
        let client = build_rpc_client(&RpcConfig {
            primary_url: "http://primary".to_owned(),
            primary_label: "primary-a".to_owned(),
            timeout_ms: 1500,
            health_probe_interval_ms: 10000,
            backup_urls: vec!["http://backup-1".to_owned(), "http://backup-2".to_owned()],
        });

        assert_eq!(client.config().primary.label, "primary-a");
        assert_eq!(client.config().backups.len(), 2);
        assert_eq!(client.config().backups[0].label, "backup-1");
        assert_eq!(client.config().backups[1].label, "backup-2");
    }

    #[test]
    fn parse_csv_env_discards_empty_entries() {
        assert_eq!(parse_csv_env("a, b, ,c"), vec!["a", "b", "c"]);
    }

    #[test]
    fn parse_recovery_range_parses_colon_pair() {
        assert_eq!(parse_recovery_range(Some("10:20")), Some((10, 20)));
        assert_eq!(parse_recovery_range(Some("bad")), None);
    }

    #[test]
    fn build_notifications_prefers_jsonl_stream_when_present() {
        let config = NodeConfig {
            database_url: None,
            subgraph: DEFAULT_SUBGRAPH.to_owned(),
            block_hashes: vec![DEFAULT_BLOCK_HASH.to_owned()],
            rpc: None,
            recovery: RecoveryConfig {
                removed_block_hashes: vec!["old".to_owned()],
                recovery_block_hashes: vec![],
                recovery_range: Some((1, 2)),
            },
            notification_stream: Some(NotificationStreamConfig {
                jsonl: Some("{\"kind\":\"BlockAdded\",\"block\":{\"hash\":\"stream-a\",\"daaScore\":1,\"blueScore\":1,\"isFinalized\":true}}".to_owned()),
                ws_url: None,
                served_by: "stream".to_owned(),
                max_messages: 16,
                idle_timeout_ms: 0,
            }),
            bootstrap_block: block("bootstrap", 1, true),
        };

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let notifications = runtime.block_on(build_notifications(&config, None)).unwrap();
        assert_eq!(notifications.len(), 1);
        match &notifications[0] {
            ChainNotification::BlockAdded(block) => assert_eq!(block.hash, "stream-a"),
            other => panic!("unexpected notification: {other:?}"),
        }
    }
}
