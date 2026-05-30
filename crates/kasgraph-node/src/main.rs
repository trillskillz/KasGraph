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
use kasgraph_detectors::{
    detect_in_output, genesis_covenant_id, kcc20_spend_operation, DetectorKind,
};
use kasgraph_poi::{compute_poi, poi_hex, PoiHash};
use kasgraph_rpc::{
    parse_notifications_jsonl, ChainNotification, IngestedBlock, IngestedTransactionInput,
    LiveRpcCapabilities, MultiRpcClient, RpcClientConfig, RpcEndpoint, SubscriptionBackoff,
};
use kasgraph_store::{
    CommittedBlockRecord, CovenantLineageHead, CovenantLineageRow, CovenantSpendRecord,
    CovenantUtxoMatch, CovenantUtxoRecord, DetectedPatternRecord, EntityVersionRecord,
    PoiCheckpoint, RpcBlockAuditRecord, Store, SubgraphId,
};
use kasgraph_stream::{StreamEvent, StreamHub};
use tokio::sync::mpsc;
use tracing::{info, warn};

// Detector-hit → WASM-mapping → entity-version bridge: the committed-block
// loop dispatches each subgraph's hits through its compiled mapping and
// persists the entity versions emitted.
mod mapping_host;

// Rust-side view of the `build/manifest.json` descriptor the CLI emits;
// resolves which handler fires for a detector hit.
mod subgraph_manifest;
use subgraph_manifest::EVENT_COVENANT_SPENT;

// Reconstructs legacy KRC-20/721 inscriptions from journaled op rows and
// replays them into a ledger — the read-back inverse of the store journal,
// used on startup and after a reorg unwind to rebuild in-memory state.
mod legacy_ledger;

const DEFAULT_SUBGRAPH: &str = "kasgraph_scaffold";
const DEFAULT_BLOCK_HASH: &str = "scaffold-block-0001";
const DEFAULT_SERVED_BY: &str = "bootstrap";
const DEFAULT_PRIMARY_RPC_LABEL: &str = "primary";
const DEFAULT_RPC_TIMEOUT_MS: u64 = 1_500;
const DEFAULT_HEALTH_PROBE_INTERVAL_MS: u64 = 10_000;

// Eq is intentionally not derived: detector_hits.payload is a
// serde_json::Value which only implements PartialEq.
#[derive(Debug, Clone, PartialEq)]
struct BootstrapBlock {
    hash: String,
    daa_score: i64,
    blue_score: i64,
    served_by: String,
    is_finalized: bool,
    canonical_entity_bytes: Vec<u8>,
    /// Per-output redeem scripts forwarded from `IngestedBlock`.
    /// Empty for synthetic/scaffold blocks that have no real wire
    /// payload. Drives the detector pass on the committed-write path.
    outputs: Vec<kasgraph_rpc::IngestedTransactionOutput>,
    /// Per-input previous-outpoint references forwarded from
    /// `IngestedBlock`. Empty for synthetic/scaffold blocks. Drives
    /// spend matching against the covenant-UTXO tracker.
    inputs: Vec<kasgraph_rpc::IngestedTransactionInput>,
    /// Detector matches computed from `outputs` once, when the
    /// block leaves `block_from_rpc`. Reused by both the
    /// canonical-bytes builder (POI input) and the persist loop
    /// (so detection runs exactly once per block).
    detector_hits: Vec<kasgraph_detectors::DetectedPattern>,
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

#[derive(Debug, Clone, PartialEq)]
struct NodeConfig {
    database_url: Option<String>,
    subgraph: String,
    block_hashes: Vec<String>,
    rpc: Option<RpcConfig>,
    recovery: RecoveryConfig,
    notification_stream: Option<NotificationStreamConfig>,
    bootstrap_block: BootstrapBlock,
    ingest_mode: IngestMode,
    continuous: ContinuousConfig,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum IngestMode {
    /// Default: one-shot bootstrap pass through configured RPC or
    /// scaffold notifications, then exit.
    Bootstrap,
    /// Long-lived loop: subscribe to the wRPC websocket via
    /// `MultiRpcClient::spawn_continuous_subscription`, consume
    /// notifications until either `max_messages` are processed or
    /// the receiver is shut down by Ctrl-C.
    Continuous,
}

impl Default for IngestMode {
    fn default() -> Self {
        Self::Bootstrap
    }
}

#[derive(Debug, Clone, PartialEq)]
struct ContinuousConfig {
    /// Websocket URL the long-lived driver subscribes to.
    /// `KASGRAPH_NOTIFICATION_WS_URL` is reused so bootstrap and
    /// continuous modes pick the same source by default.
    ws_url: Option<String>,
    served_by: String,
    /// 0 = run until shutdown signal. Non-zero is mainly for tests
    /// and bounded smoke runs.
    max_messages: usize,
    /// Channel buffer between the wRPC driver and the persistence
    /// loop. Backpressure: if the loop falls behind, the driver
    /// awaits before delivering the next notification.
    channel_capacity: usize,
    backoff_initial_ms: u64,
    backoff_max_ms: u64,
    backoff_multiplier: f64,
    backoff_max_attempts: u32,
    /// Fallback hashes to feed into `recover_blocks_by_hashes`
    /// when a runtime gap is announced but the node cannot derive
    /// a local recovery anchor hash. Empty (default) means gaps
    /// fall back to logging if anchor-based recovery is impossible.
    /// Distinct from `KASGRAPH_RECOVERY_BLOCK_HASHES`, which only
    /// drives the one-shot bootstrap replay path.
    gap_recovery_block_hashes: Vec<String>,
}

impl Default for ContinuousConfig {
    fn default() -> Self {
        Self {
            ws_url: None,
            served_by: "wrpc".to_owned(),
            max_messages: 0,
            channel_capacity: 64,
            backoff_initial_ms: 500,
            backoff_max_ms: 30_000,
            backoff_multiplier: 2.0,
            backoff_max_attempts: 0,
            gap_recovery_block_hashes: Vec::new(),
        }
    }
}

// Eq dropped transitively because BootstrapBlock.detector_hits
// holds DetectedPattern whose payload is serde_json::Value
// (PartialEq only).
//
// A block the transition selected for committed persistence. POI is NOT
// computed here: it is computed at persist time (`apply_and_persist_notification`)
// over the block's *dispatched* entity state (Phase 2.8), so the transition
// stays a pure block-promotion step and the POI chain reflects real indexed
// state rather than a pre-dispatch scaffold.
#[derive(Debug, Clone, PartialEq)]
struct CommittedBlockWrite {
    block: BootstrapBlock,
}

#[derive(Debug, Default, Clone, PartialEq)]
struct IngestionState {
    committed: BTreeMap<i64, BootstrapBlock>,
    probabilistic: BTreeMap<i64, BootstrapBlock>,
    prior_poi: PoiHash,
}

impl IngestionState {
    /// Re-anchor the POI hash chain from a known-good survivor
    /// hash. Called on startup (with the highest-DAA surviving POI
    /// from Postgres) and after each committed-state unwind so the
    /// next committed block's POI chains from the survivor, not the
    /// now-deleted block.
    fn reseed_prior_poi(&mut self, prior_poi: PoiHash) {
        self.prior_poi = prior_poi;
    }
}

#[derive(Debug, Clone, PartialEq)]
struct IngestionTransition {
    committed_writes: Vec<CommittedBlockWrite>,
    rolled_back_probabilistic: Vec<BootstrapBlock>,
    /// Hashes that arrived in a `VirtualChainChanged.removed_chain_block_hashes`
    /// list and matched a previously-committed block. The persistence
    /// layer must call `Store::unwind_committed_blocks_for_subgraph`
    /// with this list so POI + audit rows are deleted.
    committed_unwinds: Vec<BootstrapBlock>,
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
                    vec![env::var("KASGRAPH_BLOCK_HASH")
                        .unwrap_or_else(|_| DEFAULT_BLOCK_HASH.to_owned())]
                }),
            rpc: env::var("KASGRAPH_RPC_PRIMARY_URL")
                .ok()
                .map(|primary_url| RpcConfig {
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
                recovery_range: parse_recovery_range(
                    env::var("KASGRAPH_RECOVERY_RANGE").ok().as_deref(),
                ),
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
            ingest_mode: match env::var("KASGRAPH_INGEST_MODE").ok().as_deref() {
                Some("continuous") => IngestMode::Continuous,
                Some("bootstrap") | None => IngestMode::Bootstrap,
                Some(other) => {
                    warn!(
                        value = other,
                        "unknown KASGRAPH_INGEST_MODE; falling back to bootstrap"
                    );
                    IngestMode::Bootstrap
                }
            },
            continuous: ContinuousConfig {
                ws_url: env::var("KASGRAPH_NOTIFICATION_WS_URL").ok(),
                served_by: env::var("KASGRAPH_NOTIFICATION_SOURCE_LABEL")
                    .unwrap_or_else(|_| "wrpc".to_owned()),
                max_messages: env::var("KASGRAPH_CONTINUOUS_MAX_MESSAGES")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
                channel_capacity: env::var("KASGRAPH_CONTINUOUS_CHANNEL_CAPACITY")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(64),
                backoff_initial_ms: env::var("KASGRAPH_CONTINUOUS_BACKOFF_INITIAL_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(500),
                backoff_max_ms: env::var("KASGRAPH_CONTINUOUS_BACKOFF_MAX_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(30_000),
                backoff_multiplier: env::var("KASGRAPH_CONTINUOUS_BACKOFF_MULTIPLIER")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(2.0),
                backoff_max_attempts: env::var("KASGRAPH_CONTINUOUS_BACKOFF_MAX_ATTEMPTS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
                gap_recovery_block_hashes: env::var("KASGRAPH_GAP_RECOVERY_BLOCK_HASHES")
                    .ok()
                    .map(|value| parse_csv_env(&value))
                    .unwrap_or_default(),
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
                outputs: Vec::new(),
                inputs: Vec::new(),
                detector_hits: Vec::new(),
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

    info!(
        version = env!("CARGO_PKG_VERSION"),
        ?config,
        "kasgraph-node bootstrap"
    );
    info!("crates wired: rpc, store, detectors, mapping, poi, stream");

    match &config.database_url {
        Some(database_url) => {
            persist_bootstrap_state(database_url, &config)
                .await
                .context("failed to persist bootstrap state")?;
        }
        None => {
            warn!("KASGRAPH_DATABASE_URL not set; skipping migrations and persistence bootstrap");
        }
    }

    info!("phase 2 ingestion loop pending — see PLAN.md Phase 2.3–2.8");
    Ok(())
}

async fn persist_bootstrap_state(database_url: &str, config: &NodeConfig) -> Result<()> {
    let store = Store::connect(database_url)
        .await
        .with_context(|| format!("connecting to store at {database_url}"))?;
    store
        .migrate()
        .await
        .context("running shared store migrations")?;

    let subgraph =
        SubgraphId::new(config.subgraph.clone()).context("validating subgraph schema id")?;
    store
        .ensure_subgraph_schema(&subgraph)
        .await
        .with_context(|| format!("ensuring schema {} exists", subgraph.schema_name()))?;

    let rpc_client = config.rpc.as_ref().map(build_rpc_client);
    let stream_capacity = env::var("KASGRAPH_STREAM_CAPACITY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1024usize);
    let stream_hub = StreamHub::new(stream_capacity);
    info!(
        capacity = stream_capacity,
        "KasStream hub initialized; detector hits will be published to in-process subscribers"
    );

    // Optionally load the subgraph's compiled mapping. When
    // KASGRAPH_SUBGRAPH_DIR points at a built subgraph (containing
    // build/manifest.json + its wasm), committed detector hits are
    // dispatched through it and the emitted entity versions persisted.
    // Unset → the node behaves exactly as before (no mapping dispatch).
    let mapping = match env::var("KASGRAPH_SUBGRAPH_DIR").ok() {
        Some(dir) => {
            let loaded = mapping_host::LoadedMapping::load(subgraph.clone(), &dir)
                .with_context(|| format!("loading subgraph mapping from {dir}"))?;
            info!(
                subgraph = subgraph.schema_name(),
                dir,
                wasm = %loaded.descriptor.wasm,
                data_sources = loaded.descriptor.data_sources.len(),
                "loaded subgraph mapping; committed hits will be dispatched"
            );
            Some(loaded)
        }
        None => {
            info!("KASGRAPH_SUBGRAPH_DIR not set; skipping WASM mapping dispatch");
            None
        }
    };

    let mut ingestion = IngestionState::default();

    if let Some(checkpoint) = store
        .latest_poi_for_subgraph(&subgraph)
        .await
        .context("loading latest POI for subgraph on startup")?
    {
        ingestion.reseed_prior_poi(checkpoint.poi_hash);
        info!(
            subgraph = subgraph.schema_name(),
            resumed_from_daa = checkpoint.block_daa_score,
            prior_poi = poi_hex(&checkpoint.poi_hash),
            "re-anchored ingestion POI chain from existing checkpoint"
        );
    }

    match config.ingest_mode {
        IngestMode::Bootstrap => {
            let notifications = build_notifications(config, rpc_client.as_ref()).await?;
            for notification in notifications {
                let _ = apply_and_persist_notification(
                    &store,
                    &subgraph,
                    &mut ingestion,
                    notification,
                    Some(&stream_hub),
                    mapping.as_ref(),
                )
                .await?;
            }
            // Persist the provenance of any blocks the bootstrap pass fetched
            // via RPC (recorded in the client's audit log during
            // build_notifications), then clear it.
            if let Some(client) = rpc_client.as_ref() {
                let fetch_audit_rows = persist_drained_rpc_audit(&store, client).await?;
                if fetch_audit_rows > 0 {
                    info!(fetch_audit_rows, "persisted RPC fetch-audit records");
                }
            }
            info!(
                committed_blocks = ingestion.committed.len(),
                probabilistic_blocks = ingestion.probabilistic.len(),
                "ingestion pass complete"
            );
        }
        IngestMode::Continuous => {
            run_continuous_ingestion(
                &store,
                &subgraph,
                &mut ingestion,
                config,
                rpc_client.as_ref(),
                Some(&stream_hub),
                mapping.as_ref(),
            )
            .await?;
            info!(
                committed_blocks = ingestion.committed.len(),
                probabilistic_blocks = ingestion.probabilistic.len(),
                "continuous ingestion exited"
            );
        }
    }

    Ok(())
}

/// Continuous-mode preflight check. Pulled out so tests can
/// exercise it without standing up a Store fixture.
fn validate_continuous_config(config: &NodeConfig) -> Result<()> {
    if config.continuous.ws_url.is_none() {
        anyhow::bail!("KASGRAPH_INGEST_MODE=continuous requires KASGRAPH_NOTIFICATION_WS_URL");
    }
    Ok(())
}

/// Long-lived ingestion: subscribe to the wRPC websocket via
/// `MultiRpcClient::spawn_continuous_subscription`, consume the
/// resulting `ChainNotification`s, persist each one through the
/// shared `apply_and_persist_notification` helper. Exits when:
///   - `KASGRAPH_CONTINUOUS_MAX_MESSAGES` is reached (test / smoke
///     mode), or
///   - the OS sends SIGINT (Ctrl-C), or
///   - the upstream driver exhausts `max_attempts` and closes the
///     channel from the sender side.
async fn run_continuous_ingestion(
    store: &Store,
    subgraph: &SubgraphId,
    ingestion: &mut IngestionState,
    config: &NodeConfig,
    rpc_client: Option<&MultiRpcClient>,
    stream: Option<&StreamHub>,
    mapping: Option<&mapping_host::LoadedMapping>,
) -> Result<()> {
    validate_continuous_config(config)?;
    let continuous = &config.continuous;
    let ws_url = continuous.ws_url.clone().expect("validated above");

    // Reuse the configured MultiRpcClient if one exists (so HTTP
    // fallback for virtual-chain hash hydration shares health
    // probes + audit log with the rest of the node). Otherwise
    // build a single-endpoint client pointing at the ws URL — same
    // pattern as the bootstrap path.
    let driver_client = rpc_client.cloned().unwrap_or_else(|| {
        build_rpc_client(&RpcConfig {
            primary_url: ws_url.clone(),
            primary_label: continuous.served_by.clone(),
            timeout_ms: DEFAULT_RPC_TIMEOUT_MS,
            health_probe_interval_ms: DEFAULT_HEALTH_PROBE_INTERVAL_MS,
            backup_urls: Vec::new(),
        })
    });

    let capabilities = driver_client
        .probe_live_capabilities()
        .await
        .context("probing live RPC capabilities before continuous ingestion")?;
    validate_live_capabilities(&capabilities)?;
    if !capabilities.server_info.is_synced || !capabilities.node_info.is_synced {
        warn!(
            endpoint = capabilities.endpoint,
            server_version = capabilities.server_info.server_version,
            network_id = capabilities.server_info.network_id,
            "live RPC capability probe succeeded but endpoint is not fully synced"
        );
    } else {
        info!(
            endpoint = capabilities.endpoint,
            server_version = capabilities.server_info.server_version,
            network_id = capabilities.server_info.network_id,
            rpc_api_version = capabilities.server_info.rpc_api_version,
            has_message_id = capabilities.node_info.has_message_id,
            has_notify_command = capabilities.node_info.has_notify_command,
            "live RPC capability probe passed"
        );
    }

    let backoff = SubscriptionBackoff {
        initial_delay: Duration::from_millis(continuous.backoff_initial_ms),
        max_delay: Duration::from_millis(continuous.backoff_max_ms),
        multiplier: continuous.backoff_multiplier,
        max_attempts: continuous.backoff_max_attempts,
    };

    let (tx, mut rx) = mpsc::channel(continuous.channel_capacity.max(1));
    let driver_handle = driver_client.spawn_continuous_subscription(
        ws_url.clone(),
        continuous.served_by.clone(),
        tx,
        backoff,
    );

    // Periodic health probes keep endpoint_health() fresh while
    // the wRPC subscription is the only active traffic. The probe
    // loop is unconditional in continuous mode — without it, a
    // backup endpoint could be silently dead until the next
    // failover-triggered fetch_block call.
    let health_handle = driver_client.spawn_health_probe_loop();

    info!(
        ws_url = %ws_url,
        served_by = continuous.served_by,
        channel_capacity = continuous.channel_capacity,
        max_messages = continuous.max_messages,
        "continuous wRPC ingestion started"
    );

    let mut processed: usize = 0;
    loop {
        let maybe_notification = tokio::select! {
            biased;
            _ = tokio::signal::ctrl_c() => {
                info!("received Ctrl-C; shutting down continuous ingestion");
                break;
            }
            next = rx.recv() => next,
        };

        let Some(notification) = maybe_notification else {
            warn!("continuous subscription driver closed the channel; exiting ingestion loop");
            break;
        };

        let outcome = apply_and_persist_notification(
            store,
            subgraph,
            ingestion,
            notification,
            stream,
            mapping,
        )
        .await?;
        processed = processed.saturating_add(1);

        // Active gap recovery: when the driver-synthesized
        // RecoveryRequired propagates through ingestion, first try
        // to recover from the highest locally known pre-gap block
        // via `getVirtualChainFromBlock`; only fall back to the
        // operator-curated hash list when no local anchor exists.
        // The result is fed back through the same helper once — we
        // explicitly do not loop on a second RecoveryRequired to
        // avoid recovery storms.
        if let Some((from_daa, to_daa)) = outcome.recovery_requested {
            let recovery_result = if let Some(anchor_hash) =
                ingestion.recovery_anchor_hash(from_daa)
            {
                info!(
                    from_daa,
                    to_daa,
                    anchor_hash,
                    "attempting anchor-based gap recovery via getVirtualChainFromBlock"
                );
                driver_client
                    .recover_blocks_in_daa_range(&anchor_hash, from_daa, to_daa)
                    .await
            } else if !continuous.gap_recovery_block_hashes.is_empty() {
                warn!(
                    from_daa,
                    to_daa,
                    "no local recovery anchor found; falling back to KASGRAPH_GAP_RECOVERY_BLOCK_HASHES"
                );
                driver_client
                    .recover_blocks_by_hashes(
                        &continuous.gap_recovery_block_hashes,
                        from_daa,
                        to_daa,
                    )
                    .await
            } else {
                warn!(
                    from_daa,
                    to_daa,
                    "gap announced but no local recovery anchor or KASGRAPH_GAP_RECOVERY_BLOCK_HASHES is available; skipping active recovery"
                );
                continue;
            };

            match recovery_result {
                Ok(recovery_notification) => {
                    let recovered = apply_and_persist_notification(
                        store,
                        subgraph,
                        ingestion,
                        recovery_notification,
                        stream,
                        mapping,
                    )
                    .await?;
                    info!(
                        from_daa,
                        to_daa,
                        committed = recovered.committed_count,
                        "active gap recovery applied"
                    );
                }
                Err(err) => {
                    warn!(
                        from_daa,
                        to_daa,
                        error = %err,
                        "active gap recovery failed; continuing live tail"
                    );
                }
            }
        }

        // Persist (and bound) the RPC client's per-fetch audit log: recovery
        // fetches recorded which endpoint actually served each block
        // (failover-aware). Draining here makes that provenance durable and
        // keeps the in-memory log from growing without bound over a long-lived
        // loop. Subscription-delivered blocks aren't fetched, so they don't
        // appear here — their provenance is the per-committed-block audit row.
        let fetch_audit_rows = persist_drained_rpc_audit(store, &driver_client).await?;
        if fetch_audit_rows > 0 {
            info!(
                subgraph = subgraph.schema_name(),
                fetch_audit_rows, "persisted RPC fetch-audit records"
            );
        }

        if continuous.max_messages != 0 && processed >= continuous.max_messages {
            info!(
                processed,
                max_messages = continuous.max_messages,
                "reached KASGRAPH_CONTINUOUS_MAX_MESSAGES; exiting ingestion loop"
            );
            break;
        }
    }

    // Drop the receiver explicitly so the driver's
    // sender.closed() path fires before we await its handle.
    drop(rx);
    let _ = driver_handle.await;

    // The probe loop is an infinite `loop { sleep }` with no
    // shutdown signal, so abort it explicitly. Without this the
    // task would keep firing every health_probe_interval until
    // process exit.
    health_handle.abort();

    info!(processed, "continuous ingestion loop done");
    Ok(())
}

/// Drain the RPC client's accumulated per-fetch audit records and persist
/// each one. Every successful `fetch_block` (recovery + hydration paths)
/// recorded the endpoint that actually served the block (failover-aware) into
/// the client's in-memory log; draining + persisting here makes that real RPC
/// provenance durable across restarts and keeps the in-memory log bounded
/// over a long-lived ingestion loop. Returns the number of records persisted.
async fn persist_drained_rpc_audit(store: &Store, client: &MultiRpcClient) -> Result<usize> {
    let drained = client.drain_audit_log().await;
    let count = drained.len();
    for record in drained {
        store
            .insert_rpc_block_audit(&RpcBlockAuditRecord {
                block_hash: record.block_hash,
                daa_score: record.daa_score as i64,
                served_by: record.served_by,
            })
            .await
            .context("persisting drained RPC fetch-audit record")?;
    }
    Ok(count)
}

/// What a single `apply_and_persist_notification` call did, so the
/// caller can react (active gap recovery for the continuous loop,
/// logging for the bootstrap loop, …).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct NotificationOutcome {
    /// `Some(from, to)` when the notification was a
    /// `RecoveryRequired` — the continuous loop fetches missing
    /// blocks for this range when configured to.
    recovery_requested: Option<(u64, u64)>,
    /// Number of committed-block writes persisted in this call.
    committed_count: usize,
}

/// Apply one ChainNotification to the ingestion state and persist
/// every side-effect. Called from both the bootstrap-pass loop and
/// the continuous wRPC loop so they cannot drift in behaviour.
///
/// `stream` is the in-process KasStream hub. When provided, every
/// committed detector hit is published to it; `None` is a clean
/// no-op for paths that don't care (e.g. tests).
async fn apply_and_persist_notification(
    store: &Store,
    subgraph: &SubgraphId,
    ingestion: &mut IngestionState,
    notification: ChainNotification,
    stream: Option<&StreamHub>,
    mapping: Option<&mapping_host::LoadedMapping>,
) -> Result<NotificationOutcome> {
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

    if !transition.committed_unwinds.is_empty() {
        let unwound_hashes: Vec<String> = transition
            .committed_unwinds
            .iter()
            .map(|b| b.hash.clone())
            .collect();
        let report = store
            .unwind_committed_blocks_for_subgraph(
                subgraph,
                &unwound_hashes,
                "virtualChainChanged removed_chain_block_hashes",
            )
            .await
            .context("unwinding committed blocks for reorg")?;
        warn!(
            subgraph = subgraph.schema_name(),
            requested = unwound_hashes.len(),
            removed = report.removed_hashes.len(),
            audit_id = report.audit_id,
            "committed-state unwind applied"
        );

        // Unwind mapping-emitted entity versions for the same reorg.
        // The cutoff is the lowest DAA among the unwound blocks; every
        // entity row stamped at or above it is rolled back, matching the
        // committed-block unwind above. Only meaningful when a mapping is
        // loaded (otherwise no entity_versions rows exist).
        if mapping.is_some() {
            if let Some(cutoff) = transition
                .committed_unwinds
                .iter()
                .map(|b| b.daa_score)
                .min()
            {
                let removed = store
                    .unwind_entity_versions(subgraph, cutoff)
                    .await
                    .context("unwinding entity versions for reorg")?;
                // Roll back covenant UTXOs locked at or above the same
                // cutoff so the tracker matches the surviving chain — a
                // reorg that drops the lock must drop its UTXO too.
                let removed_utxos = store
                    .unwind_covenant_utxos(subgraph, cutoff)
                    .await
                    .context("unwinding covenant UTXOs for reorg")?;
                // Roll back detected spends recorded at or above the cutoff.
                // Keyed on the spending block's DAA, so a reorg that drops a
                // spend block restores spend-detectability for its outpoints.
                let removed_spends = store
                    .unwind_covenant_spends(subgraph, cutoff)
                    .await
                    .context("unwinding covenant spends for reorg")?;
                // Roll back KIP-20 lineage rows this subgraph recorded at
                // or above the cutoff and re-point the heads, so the
                // lineage view never exposes a transition the surviving
                // chain dropped.
                let removed_lineage = store
                    .unwind_covenant_lineage(subgraph, cutoff)
                    .await
                    .context("unwinding covenant lineage for reorg")?;
                warn!(
                    subgraph = subgraph.schema_name(),
                    cutoff_daa = cutoff,
                    removed_rows = removed,
                    removed_covenant_utxos = removed_utxos,
                    removed_covenant_spends = removed_spends,
                    removed_covenant_lineage = removed_lineage,
                    "entity-version unwind applied"
                );
            }
        }

        // POI re-anchor: after deleting the unwound POI rows, load
        // the new highest-DAA survivor and re-seed the in-memory
        // hash chain. If nothing survives, reset to the zero seed
        // so the next committed block restarts from genesis-style
        // chaining.
        let post_unwind = store
            .latest_poi_for_subgraph(subgraph)
            .await
            .context("loading latest POI after unwind")?;
        let reseed = post_unwind
            .as_ref()
            .map(|cp| cp.poi_hash)
            .unwrap_or_default();
        ingestion.reseed_prior_poi(reseed);
        info!(
            subgraph = subgraph.schema_name(),
            resumed_from_daa = post_unwind.as_ref().map(|cp| cp.block_daa_score),
            prior_poi = poi_hex(&reseed),
            "re-anchored ingestion POI chain after unwind"
        );
    }

    let recovery_requested = transition.recovery_requested;
    if let Some((from_daa, to_daa)) = recovery_requested {
        info!(from_daa, to_daa, "recovery requested by ingestion state");
    }

    let mut committed_count: usize = 0;
    for committed in transition.committed_writes {
        committed_count = committed_count.saturating_add(1);
        let audit = RpcBlockAuditRecord {
            block_hash: committed.block.hash.clone(),
            daa_score: committed.block.daa_score,
            served_by: committed.block.served_by.clone(),
        };
        let committed_record = CommittedBlockRecord {
            subgraph: subgraph.clone(),
            block_hash: committed.block.hash.clone(),
            daa_score: committed.block.daa_score,
            served_by: committed.block.served_by.clone(),
        };

        // Audit + reorg-tracking rows do not depend on POI; the POI checkpoint
        // is written after dispatch (below) over this block's dispatched
        // entity state (Phase 2.8).
        store
            .insert_rpc_block_audit(&audit)
            .await
            .context("writing RPC audit record")?;
        store
            .record_committed_block(&committed_record)
            .await
            .context("recording committed block for reorg-tracking")?;

        // Entity versions this block's mapping dispatched, collected so the
        // POI below hashes the real indexed state. Stays empty when no mapping
        // is loaded or the block dispatched nothing.
        let mut dispatched: Vec<EntityVersionRecord> = Vec::new();

        // Detector hits were computed once in block_from_rpc and are reused
        // here so detection-cost stays O(block), not O(2*block).
        let hits = &committed.block.detector_hits;
        if !hits.is_empty() {
            info!(
                subgraph = subgraph.schema_name(),
                block_hash = committed.block.hash,
                daa_score = committed.block.daa_score,
                hits = hits.len(),
                summary = %summarize_detector_hits(hits),
                "detector hits on committed block"
            );
            for hit in hits {
                // Assign the covenant id by lineage classification: a hit
                // whose transaction consumes a tracked covenant UTXO is a
                // transition (inherits the predecessor's id); otherwise it
                // is a genesis (a fresh deterministic id from its outpoint).
                // Gated on a loaded mapping so the no-mapping path keeps its
                // prior behavior and does no extra lookups (the tracker the
                // classification reads is only populated when a mapping is
                // loaded).
                let lineage = if mapping.is_some() {
                    Some(classify_lineage(store, subgraph, hit, &committed.block.inputs).await?)
                } else {
                    None
                };
                let covenant_id = match &lineage {
                    Some(class) => Some(class.covenant_id().to_owned()),
                    None => hit.covenant_id.clone(),
                };

                let record = DetectedPatternRecord {
                    subgraph: subgraph.clone(),
                    block_hash: committed.block.hash.clone(),
                    block_daa_score: committed.block.daa_score,
                    tx_hash: hit.tx_hash.clone(),
                    output_index: hit.output_index as i32,
                    detector_kind: format!("{:?}", hit.kind),
                    covenant_id: covenant_id.clone(),
                    payload: hit.payload.clone(),
                };
                store
                    .insert_detected_pattern(&record)
                    .await
                    .context("writing detected pattern row")?;
                publish_hit_to_stream(stream, &committed.block, hit);

                // Track this locked covenant's output as a UTXO so a later
                // input that consumes it can be recognized as the spend.
                // Gated on a loaded mapping so the tracker only fills for
                // configured subgraphs (preserving no-mapping behavior).
                if mapping.is_some() {
                    // The locked output's value is protocol-observable here,
                    // so a later spend can honestly report `spentValueSompi`
                    // without a spend-tx decoder. Match the hit's outpoint
                    // against the block's outputs.
                    let value_sompi = committed
                        .block
                        .outputs
                        .iter()
                        .find(|o| o.tx_hash == hit.tx_hash && o.output_index == hit.output_index)
                        .map(|o| o.value as i64)
                        .unwrap_or(0);
                    let utxo = CovenantUtxoRecord {
                        subgraph: subgraph.clone(),
                        tx_hash: hit.tx_hash.clone(),
                        output_index: hit.output_index as i32,
                        block_daa_score: committed.block.daa_score,
                        detector_kind: format!("{:?}", hit.kind),
                        covenant_id: covenant_id.clone(),
                        value_sompi,
                        locked_state: hit.payload.clone(),
                    };
                    store
                        .track_covenant_utxo(&utxo)
                        .await
                        .context("tracking covenant UTXO for spend detection")?;

                    // Record the KIP-20 lineage: a genesis opens a fresh
                    // head at seq 0; a transition appends the next seq and
                    // advances the head to this output. `seq` is the prior
                    // head's `lineage_count` (states already recorded), so
                    // genesis (no head) starts at 0 and each transition
                    // increments by one (KIP20_COVENANT_ID_QUERIES.md:109).
                    if let Some(class) = &lineage {
                        persist_lineage(store, subgraph, hit, class, committed.block.daa_score)
                            .await?;
                    }
                }
            }

            // Dispatch the same hits through the subgraph mapping (if one
            // is loaded) and persist the entity versions it emits. The
            // store_get read-set is seeded from the entity state committed
            // by prior blocks; rows are stamped with this block's DAA so a
            // reorg unwinds them by the same cutoff as the block itself.
            if let Some(mapping) = mapping {
                let snapshot = load_entity_snapshot(store, subgraph).await?;
                dispatched = mapping.dispatch_committed_hits(
                    committed.block.daa_score as u64,
                    &committed.block.hash,
                    hits,
                    &snapshot,
                );
                for record in &dispatched {
                    store
                        .upsert_entity_version(record)
                        .await
                        .context("persisting mapping-emitted entity version")?;
                }
                if !dispatched.is_empty() {
                    info!(
                        subgraph = subgraph.schema_name(),
                        block_hash = committed.block.hash,
                        daa_score = committed.block.daa_score,
                        entity_versions = dispatched.len(),
                        "persisted mapping entity versions"
                    );
                }
            }
        }

        // Spend detection runs on every committed block — a spend can
        // arrive in a block that locks no new covenant — so it sits
        // outside the `!hits.is_empty()` guard. Each input that consumes a
        // tracked covenant UTXO is that covenant's spend. Gated on a loaded
        // mapping so the lookup only runs for configured subgraphs.
        //
        // NOTE: this detects and persists the spend, including a
        // lineage-derived `successorCovenantId`; actual `CovenantSpent`
        // dispatch (via `mapping_host::dispatch_spend_hit`) still waits on a
        // spend-transaction decoder for the `operation` field — the example
        // mappings branch on it, so dispatching with a placeholder operation
        // would feed them wrong data. Everything else on the persisted spend
        // row is protocol-observable or lineage-derived, so it is honest
        // today.
        if let Some(mapping) = mapping {
            if !committed.block.inputs.is_empty() {
                // Group the block's inputs that consume a tracked covenant UTXO
                // by their spending transaction. The operation a spend performs
                // is a tx-level fact (the consumed-vs-created receipt-set delta),
                // so it's resolved once per spending tx and shared across that
                // tx's consumed covenants.
                let mut consumed_by_tx: BTreeMap<
                    String,
                    Vec<(&IngestedTransactionInput, CovenantUtxoMatch)>,
                > = BTreeMap::new();
                for input in &committed.block.inputs {
                    if let Some(spent) = store
                        .lookup_covenant_utxo(
                            subgraph,
                            &input.previous_tx_hash,
                            input.previous_output_index as i32,
                        )
                        .await
                        .context("looking up covenant UTXO for spend detection")?
                    {
                        consumed_by_tx
                            .entry(input.spending_tx_hash.clone())
                            .or_default()
                            .push((input, spent));
                    }
                }

                // Snapshot the committed entity state once for this block's
                // spend dispatches (same discipline as the locked path).
                let snapshot = load_entity_snapshot(store, subgraph).await?;
                let mut spends = 0usize;
                let mut dispatched_spends = 0usize;

                for (spending_tx, consumed) in &consumed_by_tx {
                    // KCC20 asset operation: classify the consumed-vs-created
                    // receipt-set delta. Only when every covenant this tx
                    // consumes is a KCC20 asset (a homogeneous KCC20 tx);
                    // otherwise the operation stays undetermined and we don't
                    // dispatch — better than feeding the mapping a guess.
                    let operation: Option<String> = if consumed
                        .iter()
                        .all(|(_, m)| m.detector_kind == "KCC20Asset")
                    {
                        let created = store
                            .covenant_utxos_created_by_tx(subgraph, spending_tx)
                            .await
                            .context("fetching covenant outputs created by the spending tx")?;
                        let consumed_states: Vec<serde_json::Value> = consumed
                            .iter()
                            .map(|(_, m)| m.locked_state.clone())
                            .collect();
                        let created_states: Vec<serde_json::Value> = created
                            .into_iter()
                            .filter(|c| c.detector_kind == "KCC20Asset")
                            .map(|c| c.locked_state)
                            .collect();
                        kcc20_spend_operation(&consumed_states, &created_states)
                            .ok()
                            .map(|op| op.as_str().to_owned())
                    } else {
                        None
                    };

                    for (input, spent) in consumed {
                        spends += 1;
                        // Successor id: a transition inherits the predecessor's
                        // id, so the successor equals the spent covenant's id
                        // when the spending tx produced a tracked covenant
                        // output carrying it (fork-agnostic EXISTS); else the
                        // lineage terminates here.
                        let successor_covenant_id = match &spent.covenant_id {
                            Some(cid)
                                if store
                                    .covenant_lineage_continues(subgraph, spending_tx, cid)
                                    .await
                                    .context("resolving covenant lineage successor")? =>
                            {
                                Some(cid.clone())
                            }
                            _ => None,
                        };
                        let spend_record = CovenantSpendRecord {
                            subgraph: subgraph.clone(),
                            spending_tx_hash: input.spending_tx_hash.clone(),
                            previous_tx_hash: input.previous_tx_hash.clone(),
                            previous_output_index: input.previous_output_index as i32,
                            block_daa_score: committed.block.daa_score,
                            detector_kind: spent.detector_kind.clone(),
                            covenant_id: spent.covenant_id.clone(),
                            spent_value_sompi: spent.value_sompi,
                            successor_covenant_id: successor_covenant_id.clone(),
                        };
                        store
                            .record_covenant_spend(&spend_record)
                            .await
                            .context("recording detected covenant spend")?;

                        // Dispatch CovenantSpent when the operation is resolved
                        // and the mapping binds a handler for this covenant kind.
                        // Each consumed covenant UTXO is one spend event; the
                        // operation is the tx-level action it was part of.
                        if let Some(op) = &operation {
                            if let Some(handler) = mapping
                                .descriptor
                                .resolve_handler(&spent.detector_kind, EVENT_COVENANT_SPENT)
                            {
                                let spend = mapping_host::CovenantSpend {
                                    operation: op.clone(),
                                    spent_value_sompi: spent.value_sompi.to_string(),
                                    successor_covenant_id: successor_covenant_id.clone(),
                                };
                                match mapping_host::dispatch_spend_hit(
                                    &mapping.runtime,
                                    &spend,
                                    spent.locked_state.clone(),
                                    committed.block.daa_score as u64,
                                    &committed.block.hash,
                                    handler,
                                    subgraph,
                                    &snapshot,
                                ) {
                                    Ok((records, _)) => {
                                        for record in &records {
                                            store.upsert_entity_version(record).await.context(
                                                "persisting spend-emitted entity version",
                                            )?;
                                        }
                                        dispatched_spends += 1;
                                    }
                                    Err(e) => warn!(
                                        subgraph = subgraph.schema_name(),
                                        detector_kind = spent.detector_kind,
                                        handler,
                                        error = %e,
                                        "CovenantSpent mapping handler failed; skipping"
                                    ),
                                }
                            }
                        }

                        info!(
                            subgraph = subgraph.schema_name(),
                            block_hash = committed.block.hash,
                            daa_score = committed.block.daa_score,
                            spending_tx = input.spending_tx_hash,
                            spent_outpoint = format!(
                                "{}:{}",
                                input.previous_tx_hash, input.previous_output_index
                            ),
                            detector_kind = spent.detector_kind,
                            covenant_id = spent.covenant_id.as_deref().unwrap_or(""),
                            spent_value_sompi = spent.value_sompi,
                            operation = operation.as_deref().unwrap_or("(undetermined)"),
                            successor_covenant_id = successor_covenant_id.as_deref().unwrap_or(""),
                            "covenant spend detected"
                        );
                    }
                }
                if spends > 0 {
                    info!(
                        subgraph = subgraph.schema_name(),
                        block_hash = committed.block.hash,
                        daa_score = committed.block.daa_score,
                        spends,
                        dispatched_spends,
                        "covenant spends detected on committed block"
                    );
                }
            }
        }

        // Phase 2.8: commit this block's POI over its dispatched entity state
        // (or the detector-hit canonical bytes when no mapping is loaded).
        // Computed here, after dispatch, so the chain commits to the real
        // indexed state a third party can recompute. `prior_poi` was already
        // re-anchored from the surviving checkpoint on any reorg above, so
        // this chains from the correct anchor.
        let poi_input = committed_poi_input(&committed.block, &dispatched, mapping.is_some());
        let poi_hash = compute_poi(&ingestion.prior_poi, &poi_input)
            .context("computing committed block POI over dispatched entities")?;
        ingestion.prior_poi = poi_hash;
        let checkpoint = PoiCheckpoint {
            subgraph: subgraph.clone(),
            block_daa_score: committed.block.daa_score,
            poi_hash,
        };
        store
            .insert_poi_checkpoint(&checkpoint)
            .await
            .context("writing POI checkpoint")?;
        info!(
            subgraph = subgraph.schema_name(),
            block_hash = committed.block.hash,
            daa_score = committed.block.daa_score,
            poi = poi_hex(&poi_hash),
            served_by = committed.block.served_by,
            finalized = committed.block.is_finalized,
            entities = dispatched.len(),
            "persisted committed checkpoint"
        );
    }

    Ok(NotificationOutcome {
        recovery_requested,
        committed_count,
    })
}

/// Build the read-only entity snapshot a mapping's `store_get` reads from:
/// the latest committed version of every entity in the subgraph.
async fn load_entity_snapshot(
    store: &Store,
    subgraph: &SubgraphId,
) -> Result<kasgraph_mapping::EntitySnapshot> {
    let rows = store
        .snapshot_entities(subgraph)
        .await
        .context("loading entity snapshot for mapping dispatch")?;
    Ok(rows
        .into_iter()
        .map(|r| ((r.entity_type, r.entity_id), r.payload))
        .collect())
}

/// The lineage classification of a detector hit: either the genesis of
/// a new covenant lineage or a transition that inherits an existing id.
enum LineageClass {
    /// First sighting of this covenant; carries its fresh deterministic id.
    Genesis(String),
    /// Inherits the predecessor's `covenant_id` (a lineage transition).
    /// Carries the spent predecessor UTXO (`tx_hash:output_index`) — the
    /// lineage edge — so a forked transfer's sibling outputs record a shared
    /// parent rather than a false linear order.
    Transition {
        covenant_id: String,
        parent_utxo: String,
    },
}

impl LineageClass {
    fn covenant_id(&self) -> &str {
        match self {
            LineageClass::Genesis(id)
            | LineageClass::Transition {
                covenant_id: id, ..
            } => id,
        }
    }

    /// The spent predecessor UTXO for a transition, or `None` for a genesis.
    fn parent_utxo(&self) -> Option<&str> {
        match self {
            LineageClass::Genesis(_) => None,
            LineageClass::Transition { parent_utxo, .. } => Some(parent_utxo),
        }
    }
}

/// Assign a covenant id to a detector hit via KIP-20 lineage rules.
/// If the hit's transaction consumes a tracked covenant UTXO, the hit
/// is a lineage transition and inherits that predecessor's id;
/// otherwise it is a genesis and gets a fresh deterministic id from its
/// own outpoint (see [`kasgraph_detectors::genesis_covenant_id`]). The
/// inherited id propagates the lineage unchanged across every spend.
async fn classify_lineage(
    store: &Store,
    subgraph: &SubgraphId,
    hit: &kasgraph_detectors::DetectedPattern,
    inputs: &[kasgraph_rpc::IngestedTransactionInput],
) -> anyhow::Result<LineageClass> {
    for input in inputs {
        if input.spending_tx_hash != hit.tx_hash {
            continue;
        }
        if let Some(prev) = store
            .lookup_covenant_utxo(
                subgraph,
                &input.previous_tx_hash,
                input.previous_output_index as i32,
            )
            .await
            .context("looking up predecessor covenant for lineage assignment")?
        {
            if let Some(id) = prev.covenant_id {
                return Ok(LineageClass::Transition {
                    covenant_id: id,
                    parent_utxo: format!(
                        "{}:{}",
                        input.previous_tx_hash, input.previous_output_index
                    ),
                });
            }
        }
    }
    Ok(LineageClass::Genesis(genesis_covenant_id(
        &hit.tx_hash,
        hit.output_index,
    )))
}

/// Persist the KIP-20 lineage state for a classified hit: append the
/// next per-transition row and advance (or open) the lineage head. The
/// next `seq` is the prior head's `lineage_count`, so a genesis (no head
/// yet) starts at seq 0 and every transition increments by one. The head
/// is keyed globally by `covenant_id`; the stored `subgraph` scopes only
/// reorg unwind. `state_bytes` is the detector payload serialized as JSON
/// so consumers can replay the covenant state at each lineage step.
async fn persist_lineage(
    store: &Store,
    subgraph: &SubgraphId,
    hit: &kasgraph_detectors::DetectedPattern,
    class: &LineageClass,
    block_daa_score: i64,
) -> anyhow::Result<()> {
    let covenant_id = class.covenant_id();

    // Replay safety: reconnect re-delivery can re-present the same hit. A
    // covenant output is one lineage step, so if this `(covenant_id, tx,
    // output)` step is already recorded, skip — re-advancing the head
    // would append a phantom transition for an already-seen state.
    if store
        .covenant_lineage_row_exists(covenant_id, &hit.tx_hash, hit.output_index as i32)
        .await
        .context("checking for an existing covenant lineage step")?
    {
        return Ok(());
    }

    let prior = store
        .fetch_covenant_lineage_head(covenant_id)
        .await
        .context("loading covenant lineage head")?;
    // Genesis tx is fixed at the lineage origin; transitions keep it.
    let genesis_tx = prior
        .as_ref()
        .map(|h| h.genesis_tx.clone())
        .unwrap_or_else(|| hit.tx_hash.clone());
    let (seq, lineage_count) = next_lineage_step(prior.as_ref().map(|h| h.lineage_count));
    let current_utxo = format!("{}:{}", hit.tx_hash, hit.output_index);
    let state_bytes =
        serde_json::to_vec(&hit.payload).context("serializing covenant lineage state bytes")?;

    let head = CovenantLineageHead {
        covenant_id: covenant_id.to_owned(),
        subgraph: subgraph.clone(),
        genesis_tx,
        current_utxo,
        last_seen_daa: block_daa_score,
        lineage_count,
    };
    store
        .upsert_covenant_lineage_head(&head)
        .await
        .context("upserting covenant lineage head")?;

    let row = CovenantLineageRow {
        covenant_id: covenant_id.to_owned(),
        subgraph: subgraph.clone(),
        seq,
        tx_hash: hit.tx_hash.clone(),
        output_index: hit.output_index as i32,
        parent_utxo: class.parent_utxo().map(str::to_owned),
        state_bytes,
        daa_score: block_daa_score,
    };
    store
        .insert_covenant_lineage_row(&row)
        .await
        .context("inserting covenant lineage row")?;

    Ok(())
}

/// Compute the next lineage `(seq, lineage_count)` from the prior head's
/// `lineage_count`. The next sequence number is the count of states
/// already recorded, so a genesis (no prior head) appends seq 0 and sets
/// the count to 1, and each transition appends the next seq and
/// increments the count by one (KIP20_COVENANT_ID_QUERIES.md:109).
fn next_lineage_step(prior_lineage_count: Option<i32>) -> (i32, i32) {
    let seq = prior_lineage_count.unwrap_or(0);
    (seq, seq + 1)
}

/// Run every registered detector against every output of `block`.
/// Production code reads `block.detector_hits` directly (populated
/// in `block_from_rpc`); this helper stays for tests that want to
/// exercise the dispatch without going through the wRPC parse path.
#[cfg(test)]
fn run_detectors_on_block(block: &BootstrapBlock) -> Vec<kasgraph_detectors::DetectedPattern> {
    let mut hits = Vec::new();
    for output in &block.outputs {
        hits.extend(detect_in_output(
            &output.script_public_key,
            &output.tx_hash,
            output.output_index,
        ));
    }
    hits
}

/// Build a `StreamEvent` from one detector hit and publish it onto
/// `hub`. `None` is a clean no-op so call sites that don't have a
/// hub (tests, bootstrap-without-stream builds) stay readable.
///
/// The payload nests the original detector payload plus the
/// `tx_hash`, `output_index`, and (if present) `covenant_id` so a
/// `StreamFilter::CovenantId(...)` consumer can match without
/// re-deriving the id from the kind-specific payload schema.
fn publish_hit_to_stream(
    hub: Option<&StreamHub>,
    block: &BootstrapBlock,
    hit: &kasgraph_detectors::DetectedPattern,
) {
    let Some(hub) = hub else { return };

    let mut payload = serde_json::Map::new();
    payload.insert(
        "tx_hash".to_owned(),
        serde_json::Value::String(hit.tx_hash.clone()),
    );
    payload.insert(
        "output_index".to_owned(),
        serde_json::Value::from(hit.output_index),
    );
    if let Some(covenant_id) = &hit.covenant_id {
        payload.insert(
            "covenant_id".to_owned(),
            serde_json::Value::String(covenant_id.clone()),
        );
    }
    payload.insert("detector_payload".to_owned(), hit.payload.clone());

    let event = StreamEvent {
        block_daa_score: block.daa_score as u64,
        block_hash: block.hash.clone(),
        kind: format!("{:?}", hit.kind),
        payload: serde_json::Value::Object(payload),
    };
    hub.publish(event);
}

/// Compact human-readable summary of detector hits for log lines.
/// Counts hits per `DetectorKind` and renders as `Vault:3,KCC20Asset:1`.
/// Iteration is insertion-ordered (first-seen kind wins position)
/// rather than alphabetical — the log line is for humans, not diff.
fn summarize_detector_hits(hits: &[kasgraph_detectors::DetectedPattern]) -> String {
    let mut counts: Vec<(DetectorKind, usize)> = Vec::new();
    for hit in hits {
        if let Some(entry) = counts.iter_mut().find(|(k, _)| *k == hit.kind) {
            entry.1 += 1;
        } else {
            counts.push((hit.kind, 1));
        }
    }
    counts
        .into_iter()
        .map(|(kind, count)| format!("{kind:?}:{count}"))
        .collect::<Vec<_>>()
        .join(",")
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
                    .with_context(|| {
                        format!("reading notification websocket stream from {ws_url}")
                    });
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

fn validate_live_capabilities(capabilities: &LiveRpcCapabilities) -> Result<()> {
    if capabilities.server_info.rpc_api_version < 1 {
        anyhow::bail!(
            "RPC endpoint {} reported unsupported rpcApiVersion={} (need >= 1)",
            capabilities.endpoint,
            capabilities.server_info.rpc_api_version
        );
    }
    if !capabilities.node_info.has_message_id {
        anyhow::bail!(
            "RPC endpoint {} does not advertise hasMessageId=true; live wRPC subscription path expects message ids",
            capabilities.endpoint
        );
    }
    if !capabilities.node_info.has_notify_command {
        anyhow::bail!(
            "RPC endpoint {} does not advertise hasNotifyCommand=true; live wRPC subscription path expects generic subscribe semantics",
            capabilities.endpoint
        );
    }

    Ok(())
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
    fn apply_notification(
        &mut self,
        notification: ChainNotification,
    ) -> Result<IngestionTransition> {
        match notification {
            ChainNotification::BlockAdded(block) => self.apply_block(block_from_rpc(block)),
            ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes,
                added_chain_blocks,
            } => {
                let mut rolled_back_probabilistic =
                    self.remove_probabilistic_by_hashes(&removed_chain_block_hashes);
                let committed_unwinds =
                    self.remove_committed_by_hashes(&removed_chain_block_hashes);
                let mut committed_writes = Vec::new();

                for block in added_chain_blocks {
                    let transition = self.apply_block(block_from_rpc(block))?;
                    rolled_back_probabilistic.extend(transition.rolled_back_probabilistic);
                    committed_writes.extend(transition.committed_writes);
                }

                Ok(IngestionTransition {
                    committed_writes,
                    rolled_back_probabilistic,
                    committed_unwinds,
                    recovery_requested: None,
                })
            }
            ChainNotification::RecoveryRequired {
                from_daa_score,
                to_daa_score,
                ..
            } => {
                let rolled_back_probabilistic =
                    self.remove_probabilistic_in_range(from_daa_score as i64, to_daa_score as i64);
                Ok(IngestionTransition {
                    committed_writes: Vec::new(),
                    rolled_back_probabilistic,
                    committed_unwinds: Vec::new(),
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
                    committed_unwinds: Vec::new(),
                    recovery_requested: None,
                });
            }

            warn!(
                existing_hash = existing.hash,
                incoming_hash = block.hash,
                daa_score = block.daa_score,
                "conflict against committed block detected; ignoring incoming block — explicit VirtualChainChanged.removed_chain_block_hashes drives committed-state unwind"
            );
            return Ok(IngestionTransition {
                committed_writes: Vec::new(),
                rolled_back_probabilistic,
                committed_unwinds: Vec::new(),
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
                committed_unwinds: Vec::new(),
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
                // POI is computed at persist time over this block's dispatched
                // entity state (Phase 2.8), not here — promotion is a pure step.
                self.committed.insert(score, probabilistic_block.clone());
                committed_writes.push(CommittedBlockWrite {
                    block: probabilistic_block,
                });
            }
        }

        Ok(IngestionTransition {
            committed_writes,
            rolled_back_probabilistic,
            committed_unwinds: Vec::new(),
            recovery_requested: None,
        })
    }

    fn remove_committed_by_hashes(&mut self, hashes: &[String]) -> Vec<BootstrapBlock> {
        let mut removed = Vec::new();
        let matching_scores: Vec<i64> = self
            .committed
            .iter()
            .filter_map(|(score, block)| hashes.contains(&block.hash).then_some(*score))
            .collect();
        for score in matching_scores {
            if let Some(block) = self.committed.remove(&score) {
                removed.push(block);
            }
        }
        removed
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
        let scores: Vec<i64> = self
            .probabilistic
            .range(from_daa..=to_daa)
            .map(|(score, _)| *score)
            .collect();
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

    fn recovery_anchor_hash(&self, from_daa: u64) -> Option<String> {
        let cutoff = from_daa.saturating_sub(1) as i64;
        self.committed
            .iter()
            .chain(self.probabilistic.iter())
            .filter(|(score, _)| **score <= cutoff)
            .max_by_key(|(score, _)| *score)
            .map(|(_, block)| block.hash.clone())
    }
}

fn block_from_rpc(block: IngestedBlock) -> BootstrapBlock {
    let detector_hits: Vec<kasgraph_detectors::DetectedPattern> = block
        .outputs
        .iter()
        .flat_map(|out| detect_in_output(&out.script_public_key, &out.tx_hash, out.output_index))
        .collect();
    let canonical_entity_bytes = canonical_bytes_for_block(&block, &detector_hits);
    BootstrapBlock {
        hash: block.hash.clone(),
        daa_score: block.daa_score as i64,
        blue_score: block.blue_score as i64,
        served_by: block.served_by,
        is_finalized: block.is_finalized,
        canonical_entity_bytes,
        outputs: block.outputs,
        inputs: block.inputs,
        detector_hits,
    }
}

fn block_to_rpc(block: &BootstrapBlock) -> IngestedBlock {
    IngestedBlock {
        hash: block.hash.clone(),
        daa_score: block.daa_score as u64,
        blue_score: block.blue_score as u64,
        is_finalized: block.is_finalized,
        served_by: block.served_by.clone(),
        outputs: block.outputs.clone(),
        inputs: block.inputs.clone(),
        payloads: Vec::new(),
    }
}

/// Canonical state bytes that feed POI for `block`.
///
/// Shape: `header || sorted-detector-rows`. The header is the
/// block's metadata (hash, daa, blue, finalized, served_by). The
/// detector rows are sorted by `(tx_hash, output_index, kind)` so
/// the byte stream is invariant under emission order — same chain
/// → same POI hash. Each row is rendered as
/// `det:<tx_hash>:<output_index>:<kind>:<covenant_id>:<payload-json>`.
///
/// Empty detector lists collapse to just the header, so synthetic
/// scaffold blocks still produce a stable POI.
/// POI input bytes for a committed block (Phase 2.8). With a mapping loaded,
/// this is the canonical encoding of the block's *dispatched* entity state
/// (`mapping_host::canonical_bytes_for_entities`), so the POI chain commits
/// to real indexed state that a third party can recompute. Without a mapping
/// there is no dispatched state, so it falls back to the block's detector-hit
/// canonical bytes — byte-identical to the pre-2.8 behavior for that path.
fn committed_poi_input(
    block: &BootstrapBlock,
    dispatched: &[EntityVersionRecord],
    mapping_loaded: bool,
) -> Vec<u8> {
    if mapping_loaded {
        mapping_host::canonical_bytes_for_entities(dispatched)
    } else {
        block.canonical_entity_bytes.clone()
    }
}

fn canonical_bytes_for_block(
    block: &IngestedBlock,
    detector_hits: &[kasgraph_detectors::DetectedPattern],
) -> Vec<u8> {
    let mut buffer = format!(
        "hash={}::daa={}::blue={}::finalized={}::served_by={}",
        block.hash, block.daa_score, block.blue_score, block.is_finalized, block.served_by
    );

    let mut rows: Vec<&kasgraph_detectors::DetectedPattern> = detector_hits.iter().collect();
    rows.sort_by(|a, b| {
        (a.tx_hash.as_str(), a.output_index, format!("{:?}", a.kind)).cmp(&(
            b.tx_hash.as_str(),
            b.output_index,
            format!("{:?}", b.kind),
        ))
    });

    for row in rows {
        let covenant = row.covenant_id.as_deref().unwrap_or("");
        // serde_json's Map preserves insertion order; we want the
        // bytes to be invariant to that, so we re-serialize through
        // a BTreeMap sort.
        let payload_canonical = canonicalize_json(&row.payload);
        buffer.push_str(&format!(
            "::det:{}:{}:{:?}:{}:{}",
            row.tx_hash, row.output_index, row.kind, covenant, payload_canonical
        ));
    }

    buffer.into_bytes()
}

/// Render `value` as a string with object keys in sorted order so
/// canonical_bytes_for_block stays stable across runs regardless of
/// how the payload was constructed.
fn canonicalize_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Object(map) => {
            let sorted: std::collections::BTreeMap<&String, &serde_json::Value> =
                map.iter().collect();
            let parts: Vec<String> = sorted
                .into_iter()
                .map(|(k, v)| format!("{:?}:{}", k, canonicalize_json(v)))
                .collect();
            format!("{{{}}}", parts.join(","))
        }
        serde_json::Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonicalize_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => other.to_string(),
    }
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
    use kasgraph_rpc::{NodeInfo, ServerInfo};

    fn block(hash: &str, daa_score: i64, finalized: bool) -> BootstrapBlock {
        BootstrapBlock {
            hash: hash.to_owned(),
            daa_score,
            blue_score: daa_score,
            served_by: "primary".to_owned(),
            is_finalized: finalized,
            canonical_entity_bytes: format!("state-{hash}-{daa_score}").into_bytes(),
            outputs: Vec::new(),
            inputs: Vec::new(),
            detector_hits: Vec::new(),
        }
    }

    fn live_capabilities(
        rpc_api_version: u64,
        has_message_id: bool,
        has_notify_command: bool,
    ) -> LiveRpcCapabilities {
        LiveRpcCapabilities {
            endpoint: "primary".to_owned(),
            server_info: ServerInfo {
                server_version: "1.0.1".to_owned(),
                network_id: "mainnet".to_owned(),
                rpc_api_version,
                rpc_api_revision: 0,
                is_synced: true,
                has_utxo_index: true,
                virtual_daa_score: Some(123),
            },
            node_info: NodeInfo {
                server_version: "1.0.1".to_owned(),
                is_synced: true,
                has_message_id,
                has_notify_command,
                is_utxo_indexed: true,
                mempool_size: Some(0),
                p2p_id: Some("peer-1".to_owned()),
            },
        }
    }

    #[test]
    fn validate_live_capabilities_accepts_supported_endpoint() {
        validate_live_capabilities(&live_capabilities(1, true, true)).unwrap();
    }

    #[test]
    fn validate_live_capabilities_rejects_unsupported_rpc_api_version() {
        let err = validate_live_capabilities(&live_capabilities(0, true, true)).unwrap_err();
        assert!(err.to_string().contains("unsupported rpcApiVersion=0"));
    }

    #[test]
    fn validate_live_capabilities_rejects_missing_message_ids() {
        let err = validate_live_capabilities(&live_capabilities(1, false, true)).unwrap_err();
        assert!(err.to_string().contains("hasMessageId=true"));
    }

    #[test]
    fn validate_live_capabilities_rejects_missing_notify_command() {
        let err = validate_live_capabilities(&live_capabilities(1, true, false)).unwrap_err();
        assert!(err.to_string().contains("hasNotifyCommand=true"));
    }

    #[test]
    fn committed_poi_input_chains_deterministically_without_a_mapping() {
        // POI now chains in the persist loop (apply_and_persist_notification),
        // not in the transition. This pins the no-mapping path: the input is
        // the block's detector-hit canonical bytes, the chain advances per
        // block, and the same input reproduces the same hash.
        let block_a = block("a", 1, true);
        let block_b = block("b", 2, true);
        let prior = PoiHash::default();
        let poi_a = compute_poi(&prior, &committed_poi_input(&block_a, &[], false)).unwrap();
        let poi_b = compute_poi(&poi_a, &committed_poi_input(&block_b, &[], false)).unwrap();
        assert_ne!(poi_a, poi_b, "distinct blocks chain to distinct POIs");
        let poi_a_again = compute_poi(&prior, &committed_poi_input(&block_a, &[], false)).unwrap();
        assert_eq!(poi_a, poi_a_again, "same input → same POI");
    }

    #[test]
    fn committed_poi_input_uses_entity_bytes_only_with_a_mapping() {
        let blk = block("x", 5, true);
        let recs = vec![EntityVersionRecord {
            subgraph: SubgraphId::new("kasbonds").unwrap(),
            entity_type: "Bond".into(),
            entity_id: "b1".into(),
            block_daa_score: 5,
            payload: serde_json::json!({ "n": 1 }),
        }];
        // Mapping loaded → POI input is the dispatched entity state, derived
        // independently of the block's scaffold canonical bytes.
        let with_mapping = committed_poi_input(&blk, &recs, true);
        assert_eq!(
            with_mapping,
            mapping_host::canonical_bytes_for_entities(&recs)
        );
        // No mapping → the block's detector-hit canonical bytes (unchanged).
        let without = committed_poi_input(&blk, &recs, false);
        assert_eq!(without, blk.canonical_entity_bytes);
        assert_ne!(with_mapping, without);
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
    fn recovery_anchor_hash_prefers_highest_known_block_below_gap_start() {
        let mut state = IngestionState::default();
        state.apply_block(block("committed-9", 9, true)).unwrap();
        state.apply_block(block("prob-12", 12, false)).unwrap();
        state.apply_block(block("prob-14", 14, false)).unwrap();

        assert_eq!(state.recovery_anchor_hash(13), Some("prob-12".to_owned()));
        assert_eq!(state.recovery_anchor_hash(20), Some("prob-14".to_owned()));
        assert_eq!(state.recovery_anchor_hash(1), None);
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
    fn virtual_chain_changed_surfaces_committed_unwinds_for_committed_removals() {
        let mut state = IngestionState::default();
        state.apply_block(block("committed-a", 100, true)).unwrap();
        state.apply_block(block("committed-b", 101, true)).unwrap();
        state
            .apply_block(block("probabilistic-c", 102, false))
            .unwrap();
        assert_eq!(state.committed.len(), 2);

        let transition = state
            .apply_notification(ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes: vec![
                    "committed-a".to_owned(),
                    "probabilistic-c".to_owned(),
                    "never-seen".to_owned(),
                ],
                added_chain_blocks: Vec::new(),
            })
            .unwrap();

        let unwound_hashes: Vec<&str> = transition
            .committed_unwinds
            .iter()
            .map(|b| b.hash.as_str())
            .collect();
        assert_eq!(unwound_hashes, vec!["committed-a"]);
        assert_eq!(transition.rolled_back_probabilistic.len(), 1);
        assert_eq!(
            transition.rolled_back_probabilistic[0].hash,
            "probabilistic-c"
        );
        assert!(!state.committed.contains_key(&100));
        assert!(state.committed.contains_key(&101));
    }

    #[test]
    fn block_added_notification_does_not_emit_committed_unwinds() {
        let mut state = IngestionState::default();
        let transition = state
            .apply_notification(ChainNotification::BlockAdded(block_to_rpc(&block(
                "x", 1, true,
            ))))
            .unwrap();
        assert!(transition.committed_unwinds.is_empty());
        assert_eq!(transition.committed_writes.len(), 1);
    }

    #[test]
    fn reseed_prior_poi_anchors_next_committed_chain_from_survivor() {
        // POI chaining moved to the persist loop, which reads `prior_poi` as
        // the anchor; `reseed_prior_poi` (called on startup and after a reorg
        // unwind) sets it. Pin that: after reseeding from a survivor POI, the
        // next block hashes from the survivor, not the zero seed.
        let block_a = block("a", 1, true);
        let survivor = compute_poi(
            &PoiHash::default(),
            &committed_poi_input(&block_a, &[], false),
        )
        .unwrap();

        let mut state = IngestionState::default();
        state.reseed_prior_poi(survivor);
        assert_eq!(state.prior_poi, survivor, "reseed sets the chain anchor");

        let block_b = block("b", 2, true);
        let from_survivor =
            compute_poi(&state.prior_poi, &committed_poi_input(&block_b, &[], false)).unwrap();
        let from_zero = compute_poi(
            &PoiHash::default(),
            &committed_poi_input(&block_b, &[], false),
        )
        .unwrap();
        assert_ne!(
            from_survivor, from_zero,
            "the re-seeded anchor must change the next block's POI"
        );
    }

    #[test]
    fn reseed_prior_poi_with_zero_resets_to_genesis_chain() {
        // Re-seeding to the default seed (no surviving checkpoint after an
        // unwind) restores the genesis anchor for the next committed block.
        let mut state = IngestionState::default();
        state.reseed_prior_poi([9u8; 32]);
        state.reseed_prior_poi(PoiHash::default());
        assert_eq!(
            state.prior_poi,
            PoiHash::default(),
            "reseed-to-default restores the genesis anchor"
        );
    }

    #[test]
    fn run_detectors_on_block_returns_empty_for_block_without_outputs() {
        let b = block("h", 1, true);
        assert!(run_detectors_on_block(&b).is_empty());
    }

    #[test]
    fn next_lineage_step_opens_genesis_at_seq_zero() {
        // No prior head: a genesis appends seq 0 and sets count to 1.
        assert_eq!(next_lineage_step(None), (0, 1));
    }

    #[test]
    fn next_lineage_step_advances_each_transition_by_one() {
        // A transition appends seq == prior count and increments count.
        assert_eq!(next_lineage_step(Some(1)), (1, 2));
        assert_eq!(next_lineage_step(Some(7)), (7, 8));
    }

    #[test]
    fn lineage_class_carries_the_parent_edge_only_for_transitions() {
        // A genesis has no predecessor; a transition records the spent UTXO so
        // forked sibling outputs share a parent rather than a false chain order.
        let genesis = LineageClass::Genesis("cid".into());
        assert_eq!(genesis.covenant_id(), "cid");
        assert_eq!(genesis.parent_utxo(), None);

        let transition = LineageClass::Transition {
            covenant_id: "cid".into(),
            parent_utxo: "txprev:2".into(),
        };
        assert_eq!(transition.covenant_id(), "cid");
        assert_eq!(transition.parent_utxo(), Some("txprev:2"));
    }

    #[test]
    fn run_detectors_on_block_invokes_registry_for_each_output() {
        use kasgraph_detectors::registry;
        use kasgraph_rpc::IngestedTransactionOutput;

        // Use the OpenSilverOwnable canonical bytes from the detector
        // registry as one of the redeem scripts, with the masked
        // state windows zeroed (still matches the fingerprint by
        // construction). A second output has a non-matching script
        // and should contribute zero hits.
        let entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .expect("OpenSilverOwnable registered");
        let kasgraph_detectors::PatternMatcher::Exact(fp) = &entry.matcher else {
            panic!("OpenSilverOwnable is an exact fingerprint");
        };
        let matching_script = fp.bytes.clone();
        let non_matching_script = vec![0x00, 0x01, 0x02];

        let mut b = block("h-detect", 1, true);
        b.outputs = vec![
            IngestedTransactionOutput {
                tx_hash: "tx-a".to_owned(),
                output_index: 0,
                script_public_key: matching_script,
                value: 1,
            },
            IngestedTransactionOutput {
                tx_hash: "tx-a".to_owned(),
                output_index: 1,
                script_public_key: non_matching_script,
                value: 2,
            },
        ];

        let hits = run_detectors_on_block(&b);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, DetectorKind::OpenSilverOwnable);
        assert_eq!(hits[0].tx_hash, "tx-a");
        assert_eq!(hits[0].output_index, 0);
    }

    #[test]
    fn summarize_detector_hits_counts_per_kind() {
        use kasgraph_detectors::DetectedPattern;
        fn hit(kind: DetectorKind) -> DetectedPattern {
            DetectedPattern {
                kind,
                covenant_id: None,
                tx_hash: "x".to_owned(),
                output_index: 0,
                payload: serde_json::json!({}),
            }
        }
        let hits = vec![
            hit(DetectorKind::OpenSilverOwnable),
            hit(DetectorKind::KCC20Asset),
            hit(DetectorKind::OpenSilverOwnable),
        ];
        let summary = summarize_detector_hits(&hits);
        assert!(summary.contains("OpenSilverOwnable:2"));
        assert!(summary.contains("KCC20Asset:1"));
    }

    #[tokio::test]
    async fn publish_hit_to_stream_delivers_event_to_subscriber() {
        use kasgraph_detectors::DetectedPattern;
        use kasgraph_stream::StreamFilter;

        let hub = StreamHub::new(8);
        let mut subscriber = hub.subscribe(vec![StreamFilter::All]);

        let block = block("h-stream", 42, true);
        let hit = DetectedPattern {
            kind: DetectorKind::KCC20Asset,
            covenant_id: Some("0xabc".to_owned()),
            tx_hash: "tx-stream".to_owned(),
            output_index: 3,
            payload: serde_json::json!({"k": "v"}),
        };

        publish_hit_to_stream(Some(&hub), &block, &hit);

        let event = subscriber.recv().await.expect("recv");
        assert_eq!(event.block_daa_score, 42);
        assert_eq!(event.block_hash, "h-stream");
        assert_eq!(event.kind, "KCC20Asset");
        assert_eq!(event.payload["tx_hash"], "tx-stream");
        assert_eq!(event.payload["output_index"], 3);
        assert_eq!(event.payload["covenant_id"], "0xabc");
        assert_eq!(event.payload["detector_payload"]["k"], "v");
    }

    #[tokio::test]
    async fn publish_hit_to_stream_with_none_hub_is_a_no_op() {
        use kasgraph_detectors::DetectedPattern;
        // No assertion needed beyond "doesn't panic"; the point is
        // that `None` is a legal hub.
        let block = block("h-none", 1, true);
        let hit = DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: None,
            tx_hash: "tx".to_owned(),
            output_index: 0,
            payload: serde_json::json!({}),
        };
        publish_hit_to_stream(None, &block, &hit);
    }

    #[tokio::test]
    async fn publish_hit_to_stream_covenant_id_filter_matches_real_hits() {
        use kasgraph_detectors::DetectedPattern;
        use kasgraph_stream::StreamFilter;

        let hub = StreamHub::new(8);
        let mut watcher = hub.subscribe(vec![StreamFilter::CovenantId("0xtarget".to_owned())]);

        let block = block("h", 1, true);

        // Mismatching covenant id — filter should drop it.
        publish_hit_to_stream(
            Some(&hub),
            &block,
            &DetectedPattern {
                kind: DetectorKind::KCC20Asset,
                covenant_id: Some("0xother".to_owned()),
                tx_hash: "t1".to_owned(),
                output_index: 0,
                payload: serde_json::json!({}),
            },
        );
        // Matching covenant id — filter should pass it through.
        publish_hit_to_stream(
            Some(&hub),
            &block,
            &DetectedPattern {
                kind: DetectorKind::KCC20Asset,
                covenant_id: Some("0xtarget".to_owned()),
                tx_hash: "t2".to_owned(),
                output_index: 0,
                payload: serde_json::json!({}),
            },
        );

        let event = watcher.recv().await.expect("recv");
        assert_eq!(event.payload["tx_hash"], "t2");
        assert_eq!(event.payload["covenant_id"], "0xtarget");
    }

    #[test]
    fn canonical_bytes_change_when_detector_hits_change() {
        use kasgraph_detectors::DetectedPattern;
        let block_meta = IngestedBlock {
            hash: "h".to_owned(),
            daa_score: 5,
            blue_score: 5,
            is_finalized: true,
            served_by: "wrpc".to_owned(),
            outputs: Vec::new(),
            inputs: Vec::new(),
            payloads: Vec::new(),
        };
        let hits_a = vec![DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: Some("0xabc".to_owned()),
            tx_hash: "tx-1".to_owned(),
            output_index: 0,
            payload: serde_json::json!({"owner": "k1"}),
        }];
        let hits_b = vec![DetectedPattern {
            kind: DetectorKind::KCC20Asset,
            covenant_id: Some("0xdef".to_owned()),
            tx_hash: "tx-1".to_owned(),
            output_index: 0,
            payload: serde_json::json!({"controller": "k2"}),
        }];

        let bytes_a = canonical_bytes_for_block(&block_meta, &hits_a);
        let bytes_b = canonical_bytes_for_block(&block_meta, &hits_b);
        let bytes_none = canonical_bytes_for_block(&block_meta, &[]);

        assert_ne!(
            bytes_a, bytes_b,
            "different hits must change canonical bytes"
        );
        assert_ne!(
            bytes_a, bytes_none,
            "presence of hits must change canonical bytes"
        );
    }

    #[test]
    fn canonical_bytes_are_stable_under_hit_reordering() {
        use kasgraph_detectors::DetectedPattern;
        let block_meta = IngestedBlock {
            hash: "h".to_owned(),
            daa_score: 5,
            blue_score: 5,
            is_finalized: true,
            served_by: "wrpc".to_owned(),
            outputs: Vec::new(),
            inputs: Vec::new(),
            payloads: Vec::new(),
        };
        let hit_one = DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: None,
            tx_hash: "tx-1".to_owned(),
            output_index: 0,
            payload: serde_json::json!({"k": "v"}),
        };
        let hit_two = DetectedPattern {
            kind: DetectorKind::KCC20Asset,
            covenant_id: None,
            tx_hash: "tx-2".to_owned(),
            output_index: 0,
            payload: serde_json::json!({"k": "v"}),
        };

        let forward = canonical_bytes_for_block(&block_meta, &[hit_one.clone(), hit_two.clone()]);
        let reversed = canonical_bytes_for_block(&block_meta, &[hit_two, hit_one]);
        assert_eq!(
            forward, reversed,
            "canonical bytes must not depend on hit order"
        );
    }

    #[test]
    fn canonical_bytes_are_stable_under_payload_key_reordering() {
        use kasgraph_detectors::DetectedPattern;
        let block_meta = IngestedBlock {
            hash: "h".to_owned(),
            daa_score: 5,
            blue_score: 5,
            is_finalized: true,
            served_by: "wrpc".to_owned(),
            outputs: Vec::new(),
            inputs: Vec::new(),
            payloads: Vec::new(),
        };
        // Two payloads with the same key/value pairs but constructed
        // from different JSON literals — serde preserves source
        // order in Value::Object, so canonicalize_json must sort.
        let payload_ab: serde_json::Value =
            serde_json::from_str(r#"{"a": "1", "b": "2"}"#).unwrap();
        let payload_ba: serde_json::Value =
            serde_json::from_str(r#"{"b": "2", "a": "1"}"#).unwrap();
        let hit_ab = DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: None,
            tx_hash: "tx".to_owned(),
            output_index: 0,
            payload: payload_ab,
        };
        let hit_ba = DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: None,
            tx_hash: "tx".to_owned(),
            output_index: 0,
            payload: payload_ba,
        };

        let bytes_ab = canonical_bytes_for_block(&block_meta, &[hit_ab]);
        let bytes_ba = canonical_bytes_for_block(&block_meta, &[hit_ba]);
        assert_eq!(bytes_ab, bytes_ba, "payload key order must not affect POI");
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
                outputs: Vec::new(),
                inputs: Vec::new(),
                detector_hits: Vec::new(),
            },
            ingest_mode: IngestMode::default(),
            continuous: ContinuousConfig::default(),
        };

        assert_eq!(config.subgraph, "kasgraph_scaffold");
        assert_eq!(config.bootstrap_block.served_by, "bootstrap");
        assert_eq!(config.ingest_mode, IngestMode::Bootstrap);
        assert_eq!(config.continuous.channel_capacity, 64);
        assert_eq!(config.continuous.backoff_initial_ms, 500);
        assert_eq!(config.continuous.backoff_max_attempts, 0);
        assert_eq!(config.continuous.max_messages, 0);
    }

    #[test]
    fn block_from_rpc_maps_fields_and_builds_canonical_bytes() {
        let block = IngestedBlock {
            hash: "abc".to_owned(),
            daa_score: 42,
            blue_score: 7,
            is_finalized: true,
            served_by: "primary".to_owned(),
            outputs: Vec::new(),
            inputs: vec![kasgraph_rpc::IngestedTransactionInput {
                spending_tx_hash: "spend-tx".to_owned(),
                previous_tx_hash: "cov-utxo".to_owned(),
                previous_output_index: 1,
            }],
            payloads: Vec::new(),
        };

        let mapped = block_from_rpc(block);
        assert_eq!(mapped.hash, "abc");
        assert_eq!(mapped.daa_score, 42);
        assert_eq!(mapped.blue_score, 7);
        assert_eq!(mapped.served_by, "primary");
        assert!(mapped.is_finalized);
        // Inputs thread through unchanged so the committed loop can match
        // them against the covenant-UTXO tracker.
        assert_eq!(mapped.inputs.len(), 1);
        assert_eq!(mapped.inputs[0].previous_tx_hash, "cov-utxo");
        assert_eq!(mapped.inputs[0].previous_output_index, 1);
        assert!(String::from_utf8(mapped.canonical_entity_bytes)
            .unwrap()
            .contains("finalized=true"));
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
    fn ingest_mode_defaults_to_bootstrap() {
        assert_eq!(IngestMode::default(), IngestMode::Bootstrap);
    }

    #[test]
    fn continuous_config_defaults_match_documented_values() {
        let c = ContinuousConfig::default();
        assert!(c.ws_url.is_none());
        assert_eq!(c.served_by, "wrpc");
        assert_eq!(c.max_messages, 0);
        assert_eq!(c.channel_capacity, 64);
        assert_eq!(c.backoff_initial_ms, 500);
        assert_eq!(c.backoff_max_ms, 30_000);
        assert_eq!(c.backoff_multiplier, 2.0);
        assert_eq!(c.backoff_max_attempts, 0);
        assert!(
            c.gap_recovery_block_hashes.is_empty(),
            "gap recovery defaults to off; operator opts in via env"
        );
    }

    #[test]
    fn notification_outcome_default_indicates_no_recovery_and_no_writes() {
        let outcome = NotificationOutcome::default();
        assert!(outcome.recovery_requested.is_none());
        assert_eq!(outcome.committed_count, 0);
    }

    #[tokio::test]
    async fn run_continuous_ingestion_fails_without_ws_url() {
        // We don't have a Store fixture in unit tests, so this only
        // exercises the early-return validation. The Store is never
        // touched on the bail path.
        let store_url = "postgres://localhost/should-not-be-touched";
        // We use a sentinel store value via a small helper: connect
        // is async + needs a real PG, so we skip it by checking only
        // the validation error before that point.
        let mut config = NodeConfig {
            database_url: Some(store_url.to_owned()),
            subgraph: DEFAULT_SUBGRAPH.to_owned(),
            block_hashes: vec![DEFAULT_BLOCK_HASH.to_owned()],
            rpc: None,
            recovery: RecoveryConfig {
                removed_block_hashes: Vec::new(),
                recovery_block_hashes: Vec::new(),
                recovery_range: None,
            },
            notification_stream: None,
            bootstrap_block: block("bootstrap", 1, true),
            ingest_mode: IngestMode::Continuous,
            continuous: ContinuousConfig::default(),
        };
        config.continuous.ws_url = None;

        // Skip the real store dependency by constructing the
        // validation through a small helper. The first thing
        // run_continuous_ingestion does is check for ws_url and
        // bail.
        assert!(config.continuous.ws_url.is_none());
        assert_eq!(config.ingest_mode, IngestMode::Continuous);
        // Direct call would require a live Store. We assert the
        // precondition guard via a focused function instead.
        let validation = validate_continuous_config(&config);
        assert!(validation.is_err());
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
            ingest_mode: IngestMode::default(),
            continuous: ContinuousConfig::default(),
        };

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let notifications = runtime
            .block_on(build_notifications(&config, None))
            .unwrap();
        assert_eq!(notifications.len(), 1);
        match &notifications[0] {
            ChainNotification::BlockAdded(block) => assert_eq!(block.hash, "stream-a"),
            other => panic!("unexpected notification: {other:?}"),
        }
    }
}

/// End-to-end coverage of the Phase 2.8 persist loop against live Postgres:
/// drives `apply_and_persist_notification` with a real committed-block
/// notification through a loaded mapping, and asserts the *persisted* POI
/// checkpoint equals `compute_poi` over `canonical_bytes_for_entities` of the
/// dispatched entities — closing the gap the unit tests leave (they cover the
/// pieces, not the loop wiring). Gated behind `integration-pg` (off by
/// default); run with:
///   DATABASE_URL=postgres://kasgraph:kasgraph@127.0.0.1:5434/kasgraph \
///     cargo test -p kasgraph-node --features integration-pg
#[cfg(all(test, feature = "integration-pg"))]
mod integration_pg_persist {
    use super::*;
    use kasgraph_detectors::{registry, DetectorKind};
    use kasgraph_rpc::{ChainNotification, IngestedBlock, IngestedTransactionOutput};
    use sqlx::PgPool;
    use std::path::PathBuf;

    // handleLock unconditionally emits a fixed Bond/b1 entity, so a committed
    // OpenSilverOwnable hit dispatches a known entity we can hash into the
    // expected POI independently of the (ignored) event payload.
    const EMIT_WAT: &str = r#"
        (module
          (import "kasgraph" "store_set" (func $store_set (param i32 i32)))
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "kasgraph_alloc") (param $len i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $heap))
            (global.set $heap (i32.add (global.get $heap) (local.get $len)))
            (local.get $p))
          (data (i32.const 0) "{\"entity\":\"Bond\",\"id\":\"b1\",\"data\":{\"n\":7}}")
          (func (export "handleLock") (param i32 i32)
            (call $store_set (i32.const 0) (i32.const 42))))
    "#;

    fn write_fixture() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("kasgraph_persistit_{}_{nanos}", std::process::id()));
        let build = dir.join("build");
        std::fs::create_dir_all(&build).unwrap();
        let manifest = r#"{ "name":"itest", "wasm":"mapping.wasm", "dataSources":[
            { "name":"d", "kind":"covenant_id", "patterns":["OpenSilverOwnable"],
              "collection":null, "addresses":[],
              "handlers":[{"event":"CovenantLocked","handler":"handleLock"}] } ]}"#;
        std::fs::write(build.join("manifest.json"), manifest).unwrap();
        std::fs::write(build.join("mapping.wasm"), EMIT_WAT).unwrap();
        dir
    }

    #[sqlx::test(migrations = "../kasgraph-store/migrations")]
    async fn persist_loop_commits_poi_over_dispatched_entities(pool: PgPool) -> sqlx::Result<()> {
        let store = Store::from_pool(pool);
        let sg = SubgraphId::new("itest_persist_poi").unwrap();
        store.ensure_subgraph_schema(&sg).await.unwrap();

        let dir = write_fixture();
        let mapping = mapping_host::LoadedMapping::load(sg.clone(), &dir).unwrap();

        // A finalized block whose one output matches the OpenSilverOwnable
        // fingerprint → exactly one committed detector hit → handleLock fires.
        let owner_entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .expect("OpenSilverOwnable registered");
        let kasgraph_detectors::PatternMatcher::Exact(fp) = &owner_entry.matcher else {
            panic!("OpenSilverOwnable is an exact fingerprint");
        };
        let script = fp.bytes.clone();
        let ingested = IngestedBlock {
            hash: "blk-1".into(),
            daa_score: 100,
            blue_score: 100,
            is_finalized: true,
            served_by: "primary".into(),
            outputs: vec![IngestedTransactionOutput {
                tx_hash: "tx-a".into(),
                output_index: 0,
                script_public_key: script,
                value: 1,
            }],
            inputs: Vec::new(),
            payloads: Vec::new(),
        };

        let mut ingestion = IngestionState::default();
        let outcome = apply_and_persist_notification(
            &store,
            &sg,
            &mut ingestion,
            ChainNotification::BlockAdded(ingested),
            None,
            Some(&mapping),
        )
        .await
        .unwrap();
        assert_eq!(outcome.committed_count, 1);

        // Independently recompute the POI the loop should have committed:
        // compute_poi(genesis, canonical_bytes_for_entities([Bond/b1={"n":7}])).
        let dispatched = vec![EntityVersionRecord {
            subgraph: sg.clone(),
            entity_type: "Bond".into(),
            entity_id: "b1".into(),
            block_daa_score: 100,
            payload: serde_json::json!({ "n": 7 }),
        }];
        let expected_bytes = mapping_host::canonical_bytes_for_entities(&dispatched);
        let expected_poi = compute_poi(&PoiHash::default(), &expected_bytes).unwrap();

        // The persisted checkpoint hashes the dispatched entity state, and the
        // in-memory chain advanced to it.
        let latest = store
            .latest_poi_for_subgraph(&sg)
            .await
            .unwrap()
            .expect("a POI checkpoint was written");
        assert_eq!(latest.block_daa_score, 100);
        assert_eq!(
            latest.poi_hash, expected_poi,
            "persisted POI must hash the dispatched entity state, not a scaffold"
        );
        assert_eq!(
            ingestion.prior_poi, expected_poi,
            "the in-memory POI chain advanced to the committed checkpoint"
        );

        // Sanity: dispatch actually ran and persisted the entity.
        assert_eq!(
            store.latest_entity(&sg, "Bond", "b1").await.unwrap(),
            Some(serde_json::json!({ "n": 7 }))
        );

        // A third party can verify the one-block chain from genesis.
        let checkpoints = [kasgraph_poi::PoiCheckpoint {
            canonical_entity_bytes: &expected_bytes,
            expected_poi,
        }];
        assert!(matches!(
            kasgraph_poi::verify_poi_chain(&checkpoints).unwrap(),
            kasgraph_poi::PoiVerification::Valid { .. }
        ));

        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }

    // A real `silverc` compile of `kcc20.sil` (the (5,5) instance: owner=07×32,
    // identifier_type=2, amount=999, is_minter=true) — used as a KCC20 covenant
    // output so the real anchored fingerprint detects + extracts it.
    const KCC20_INSTANCE_HEX: &str = include_str!("testdata/kcc20_asset_instance.hex");

    // handleLock is a no-op (so only the spend emission is asserted); handleSpent
    // emits a fixed Spend/s1 entity, proving the CovenantSpent handler fired.
    const SPEND_WAT: &str = r#"
        (module
          (import "kasgraph" "store_set" (func $store_set (param i32 i32)))
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "kasgraph_alloc") (param $len i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $heap))
            (global.set $heap (i32.add (global.get $heap) (local.get $len)))
            (local.get $p))
          (data (i32.const 0) "{\"entity\":\"Spend\",\"id\":\"s1\",\"data\":{\"n\":7}}")
          (func (export "handleLock") (param i32 i32))
          (func (export "handleSpent") (param i32 i32)
            (call $store_set (i32.const 0) (i32.const 43))))
    "#;

    fn write_spend_fixture() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("kasgraph_spendit_{}_{nanos}", std::process::id()));
        let build = dir.join("build");
        std::fs::create_dir_all(&build).unwrap();
        let manifest = r#"{ "name":"itest", "wasm":"mapping.wasm", "dataSources":[
            { "name":"d", "kind":"covenant_id", "patterns":["KCC20Asset"],
              "collection":null, "addresses":[],
              "handlers":[
                {"event":"CovenantLocked","handler":"handleLock"},
                {"event":"CovenantSpent","handler":"handleSpent"}] } ]}"#;
        std::fs::write(build.join("manifest.json"), manifest).unwrap();
        std::fs::write(build.join("mapping.wasm"), SPEND_WAT).unwrap();
        dir
    }

    /// End-to-end CovenantSpent dispatch: lock a real KCC20 asset covenant in
    /// one block, then spend it (consuming its outpoint and producing a
    /// successor KCC20 output) in the next. The node must detect the spend,
    /// classify the operation from the consumed+created receipt sets, resolve
    /// the `CovenantSpent` handler, dispatch it, and persist the emitted entity.
    #[sqlx::test(migrations = "../kasgraph-store/migrations")]
    async fn committed_spend_dispatches_covenant_spent(pool: PgPool) -> sqlx::Result<()> {
        let store = Store::from_pool(pool);
        let sg = SubgraphId::new("itest_spend").unwrap();
        store.ensure_subgraph_schema(&sg).await.unwrap();

        let dir = write_spend_fixture();
        let mapping = mapping_host::LoadedMapping::load(sg.clone(), &dir).unwrap();
        let kcc20 = hex::decode(KCC20_INSTANCE_HEX.trim()).expect("valid KCC20 instance hex");

        let mut ingestion = IngestionState::default();

        // Block 1: locks a KCC20 asset covenant (detected via the real
        // anchored fingerprint, tracked as a covenant UTXO).
        let lock_block = IngestedBlock {
            hash: "blk-lock".into(),
            daa_score: 100,
            blue_score: 100,
            is_finalized: true,
            served_by: "primary".into(),
            outputs: vec![IngestedTransactionOutput {
                tx_hash: "tx-lock".into(),
                output_index: 0,
                script_public_key: kcc20.clone(),
                value: 1000,
            }],
            inputs: Vec::new(),
            payloads: Vec::new(),
        };
        apply_and_persist_notification(
            &store,
            &sg,
            &mut ingestion,
            ChainNotification::BlockAdded(lock_block),
            None,
            Some(&mapping),
        )
        .await
        .unwrap();

        // Block 2: spends tx-lock:0 and produces a successor KCC20 output, so
        // the spend loop sees a consumed + a created KCC20 receipt → transfer.
        let spend_block = IngestedBlock {
            hash: "blk-spend".into(),
            daa_score: 200,
            blue_score: 200,
            is_finalized: true,
            served_by: "primary".into(),
            outputs: vec![IngestedTransactionOutput {
                tx_hash: "tx-spend".into(),
                output_index: 0,
                script_public_key: kcc20.clone(),
                value: 1000,
            }],
            inputs: vec![IngestedTransactionInput {
                spending_tx_hash: "tx-spend".into(),
                previous_tx_hash: "tx-lock".into(),
                previous_output_index: 0,
            }],
            payloads: Vec::new(),
        };
        apply_and_persist_notification(
            &store,
            &sg,
            &mut ingestion,
            ChainNotification::BlockAdded(spend_block),
            None,
            Some(&mapping),
        )
        .await
        .unwrap();

        // The CovenantSpent handler fired and persisted its entity — proving
        // detection → operation classification → handler resolution → dispatch.
        assert_eq!(
            store.latest_entity(&sg, "Spend", "s1").await.unwrap(),
            Some(serde_json::json!({ "n": 7 })),
            "CovenantSpent dispatch must persist the spend handler's entity"
        );

        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }
}
