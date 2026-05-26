//! kasgraph-rpc — Multi-RPC client for Kaspa with failover.
//!
//! Goals (per `PLAN.md` Phase 2.2):
//!   - Primary RPC + N backup RPCs
//!   - Automatic failover on timeout or error
//!   - Health checks against each source
//!   - Audit log of which source served which block
//!
//! Goals (per `PLAN.md` Phase 2.3):
//!   - BlockDAG-aware reorg handling using KIP-20 confirmation finality
//!   - Buffer probabilistic blocks separately from confirmed
//!   - Replay-safe state transitions

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
    sync::{Mutex, RwLock, mpsc},
    task::JoinHandle,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::warn;

/// One configured Kaspa RPC endpoint.
#[derive(Debug, Clone)]
pub struct RpcEndpoint {
    /// Human-readable label used in audit logs and metrics.
    pub label: String,
    /// JSON-RPC or wRPC URL.
    pub url: String,
    /// How long to wait for a response before considering this endpoint
    /// failed for the in-flight request.
    pub timeout: Duration,
}

/// Multi-RPC client configuration.
#[derive(Debug, Clone)]
pub struct RpcClientConfig {
    pub primary: RpcEndpoint,
    /// Failover order. Rotated in round-robin order after the primary.
    pub backups: Vec<RpcEndpoint>,
    /// Health-check probe cadence.
    pub health_probe_interval: Duration,
}

impl RpcClientConfig {
    pub fn all_endpoints(&self) -> Vec<RpcEndpoint> {
        let mut endpoints = Vec::with_capacity(1 + self.backups.len());
        endpoints.push(self.primary.clone());
        endpoints.extend(self.backups.clone());
        endpoints
    }

    fn failover_chain(&self, backup_start: usize) -> Vec<RpcEndpoint> {
        let mut endpoints = Vec::with_capacity(1 + self.backups.len());
        endpoints.push(self.primary.clone());

        if self.backups.is_empty() {
            return endpoints;
        }

        for offset in 0..self.backups.len() {
            let index = (backup_start + offset) % self.backups.len();
            endpoints.push(self.backups[index].clone());
        }

        endpoints
    }
}

#[derive(Debug, Error)]
pub enum RpcError {
    #[error("all configured RPC endpoints are unreachable")]
    AllEndpointsFailed,

    #[error("RPC transport error against {endpoint}: {source}")]
    Transport {
        endpoint: String,
        #[source]
        source: anyhow_compat::AnyhowError,
    },

    #[error("websocket subscription rejected by {endpoint}: {message}")]
    SubscriptionRejected {
        endpoint: String,
        message: String,
    },

    #[error("RPC returned a malformed response: {0}")]
    MalformedResponse(String),
}

// Local stand-in until anyhow lands as a workspace dep here. Keeping
// the error variant shape stable lets dependents pattern-match without
// thrashing later.
pub mod anyhow_compat {
    #[derive(Debug)]
    pub struct AnyhowError(pub String);

    impl std::fmt::Display for AnyhowError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "{}", self.0)
        }
    }

    impl std::error::Error for AnyhowError {}
}

/// A block as KasGraph ingests it from the RPC layer.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct IngestedBlock {
    pub hash: String,
    pub daa_score: u64,
    pub blue_score: u64,
    /// Whether the block has crossed the KIP-20 confirmation finality
    /// threshold the indexer treats as "safe to commit."
    pub is_finalized: bool,
    /// Audit field: which endpoint served this block.
    pub served_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockAuditRecord {
    pub block_hash: String,
    pub daa_score: u64,
    pub served_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EndpointHealth {
    pub endpoint: String,
    pub healthy: bool,
}

/// Minimal live-ingestion notification surface for Phase 2.3.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChainNotification {
    BlockAdded(IngestedBlock),
    VirtualChainChanged {
        removed_chain_block_hashes: Vec<String>,
        added_chain_blocks: Vec<IngestedBlock>,
    },
    RecoveryRequired {
        from_daa_score: u64,
        to_daa_score: u64,
        reason: String,
    },
}

/// Multi-RPC client with primary-first failover and background health probes.
#[derive(Clone)]
pub struct MultiRpcClient {
    config: RpcClientConfig,
    http_client: reqwest::Client,
    health: Arc<RwLock<HashMap<String, bool>>>,
    audit_log: Arc<Mutex<Vec<BlockAuditRecord>>>,
    next_backup_index: Arc<AtomicUsize>,
}

impl MultiRpcClient {
    pub fn new(config: RpcClientConfig) -> Self {
        let mut health = HashMap::new();
        for endpoint in config.all_endpoints() {
            health.insert(endpoint.label.clone(), true);
        }

        Self {
            config,
            http_client: reqwest::Client::new(),
            health: Arc::new(RwLock::new(health)),
            audit_log: Arc::new(Mutex::new(Vec::new())),
            next_backup_index: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn config(&self) -> &RpcClientConfig {
        &self.config
    }

    pub async fn fetch_block(&self, block_hash: &str) -> Result<IngestedBlock, RpcError> {
        let backup_start = self.next_backup_index.fetch_add(1, Ordering::Relaxed);
        let endpoints = self.config.failover_chain(backup_start);
        let mut last_err = None;

        for endpoint in endpoints {
            match self.fetch_block_from_endpoint(&endpoint, block_hash).await {
                Ok(block) => {
                    self.set_endpoint_health(&endpoint.label, true).await;
                    self.record_audit(&block).await;
                    return Ok(block);
                }
                Err(err) => {
                    self.set_endpoint_health(&endpoint.label, false).await;
                    warn!(endpoint = endpoint.label, error = %err, "kasgraph-rpc endpoint failed; trying next source");
                    last_err = Some(err);
                }
            }
        }

        Err(last_err.unwrap_or(RpcError::AllEndpointsFailed))
    }

    pub async fn fetch_blocks<I, S>(&self, block_hashes: I) -> Result<Vec<IngestedBlock>, RpcError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut blocks = Vec::new();
        for hash in block_hashes {
            blocks.push(self.fetch_block(hash.as_ref()).await?);
        }
        Ok(blocks)
    }

    pub async fn probe_health_once(&self) -> Vec<EndpointHealth> {
        let mut statuses = Vec::new();

        for endpoint in self.config.all_endpoints() {
            let healthy = self.probe_endpoint(&endpoint).await;
            self.set_endpoint_health(&endpoint.label, healthy).await;
            statuses.push(EndpointHealth {
                endpoint: endpoint.label.clone(),
                healthy,
            });
        }

        statuses
    }

    pub fn spawn_health_probe_loop(&self) -> JoinHandle<()> {
        let client = self.clone();
        tokio::spawn(async move {
            let interval = client.config.health_probe_interval;
            loop {
                client.probe_health_once().await;
                tokio::time::sleep(interval).await;
            }
        })
    }

    pub async fn endpoint_health(&self) -> HashMap<String, bool> {
        self.health.read().await.clone()
    }

    pub async fn audit_log(&self) -> Vec<BlockAuditRecord> {
        self.audit_log.lock().await.clone()
    }

    pub async fn recover_blocks_by_hashes<I, S>(
        &self,
        block_hashes: I,
        from_daa_score: u64,
        to_daa_score: u64,
    ) -> Result<ChainNotification, RpcError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let recovered = self.fetch_blocks(block_hashes).await?;
        Ok(ChainNotification::VirtualChainChanged {
            removed_chain_block_hashes: Vec::new(),
            added_chain_blocks: recovered
                .into_iter()
                .filter(|block| block.daa_score >= from_daa_score && block.daa_score <= to_daa_score)
                .collect(),
        })
    }

    pub fn parse_notifications_jsonl(
        &self,
        jsonl: &str,
        served_by: &str,
    ) -> Result<Vec<ChainNotification>, RpcError> {
        parse_notifications_jsonl(jsonl, served_by)
    }

    /// Spawn a long-lived task that subscribes to `url`, parses each
    /// incoming notification, and pushes it onto `sender`. The task
    /// reconnects with exponential backoff on transport errors and
    /// on clean server-side disconnects. It exits when:
    ///   - `sender` is closed (downstream consumer dropped the
    ///     receiver), or
    ///   - `backoff.max_attempts` is reached (only when non-zero).
    ///
    /// Each reconnect resends the same `notifyBlockAdded` and
    /// `notifyVirtualChainChanged` subscribe payloads as the
    /// one-shot reader. The returned `JoinHandle` lets callers
    /// observe completion; awaiting it is optional.
    pub fn spawn_continuous_subscription(
        &self,
        url: String,
        served_by: String,
        sender: mpsc::Sender<ChainNotification>,
        backoff: SubscriptionBackoff,
    ) -> JoinHandle<()> {
        let client = self.clone();
        tokio::spawn(async move {
            run_continuous_subscription(client, url, served_by, sender, backoff).await;
        })
    }

    pub async fn read_notifications_ws(
        &self,
        url: &str,
        served_by: &str,
        max_messages: usize,
        idle_timeout_ms: u64,
    ) -> Result<Vec<ChainNotification>, RpcError> {
        read_notifications_ws(self, url, served_by, max_messages, idle_timeout_ms).await
    }

    async fn fetch_block_from_endpoint(
        &self,
        endpoint: &RpcEndpoint,
        block_hash: &str,
    ) -> Result<IngestedBlock, RpcError> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBlock",
            "params": {
                "hash": block_hash,
                "includeTransactions": true
            }
        });

        let response = self.post_json(endpoint, payload).await?;
        parse_ingested_block(response, &endpoint.label)
    }

    async fn probe_endpoint(&self, endpoint: &RpcEndpoint) -> bool {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getBlockDagInfo",
            "params": {}
        });

        self.post_json(endpoint, payload).await.is_ok()
    }

    async fn post_json(&self, endpoint: &RpcEndpoint, payload: Value) -> Result<Value, RpcError> {
        let response = self
            .http_client
            .post(&endpoint.url)
            .timeout(endpoint.timeout)
            .json(&payload)
            .send()
            .await
            .map_err(|err| RpcError::Transport {
                endpoint: endpoint.label.clone(),
                source: anyhow_compat::AnyhowError(err.to_string()),
            })?;

        response.json::<Value>().await.map_err(|err| RpcError::Transport {
            endpoint: endpoint.label.clone(),
            source: anyhow_compat::AnyhowError(err.to_string()),
        })
    }

    async fn set_endpoint_health(&self, endpoint: &str, healthy: bool) {
        self.health.write().await.insert(endpoint.to_owned(), healthy);
    }

    async fn record_audit(&self, block: &IngestedBlock) {
        self.audit_log.lock().await.push(BlockAuditRecord {
            block_hash: block.hash.clone(),
            daa_score: block.daa_score,
            served_by: block.served_by.clone(),
        });
    }
}

pub fn parse_notifications_jsonl(
    jsonl: &str,
    served_by: &str,
) -> Result<Vec<ChainNotification>, RpcError> {
    let mut notifications = Vec::new();
    for line in jsonl.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: Value = serde_json::from_str(trimmed)
            .map_err(|err| RpcError::MalformedResponse(err.to_string()))?;
        notifications.push(parse_chain_notification(value, served_by)?);
    }
    Ok(notifications)
}

/// Reconnect/backoff policy for [`MultiRpcClient::spawn_continuous_subscription`].
///
/// Delay grows by `multiplier` on each consecutive failure and is
/// clamped to `max_delay`. A clean disconnect (server closed the
/// stream without error) resets the delay to `initial_delay`.
#[derive(Debug, Clone)]
pub struct SubscriptionBackoff {
    pub initial_delay: Duration,
    pub max_delay: Duration,
    pub multiplier: f64,
    /// 0 means retry forever.
    pub max_attempts: u32,
}

impl Default for SubscriptionBackoff {
    fn default() -> Self {
        Self {
            initial_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(30),
            multiplier: 2.0,
            max_attempts: 0,
        }
    }
}

async fn run_continuous_subscription(
    client: MultiRpcClient,
    url: String,
    served_by: String,
    sender: mpsc::Sender<ChainNotification>,
    backoff: SubscriptionBackoff,
) {
    let mut attempt: u32 = 0;
    let mut delay = backoff.initial_delay;

    loop {
        if sender.is_closed() {
            return;
        }

        match run_subscription_once(&client, &url, &served_by, &sender).await {
            Ok(()) => {
                attempt = 0;
                delay = backoff.initial_delay;
                warn!(
                    url = %url,
                    "wRPC subscription stream ended; reconnecting"
                );
            }
            Err(err) => {
                attempt = attempt.saturating_add(1);
                if backoff.max_attempts != 0 && attempt > backoff.max_attempts {
                    warn!(
                        url = %url,
                        attempts = attempt,
                        error = %err,
                        "wRPC subscription exhausted max_attempts; giving up"
                    );
                    return;
                }
                warn!(
                    url = %url,
                    attempt = attempt,
                    delay_ms = delay.as_millis() as u64,
                    error = %err,
                    "wRPC subscription error; backing off before reconnect"
                );
                tokio::time::sleep(delay).await;
                let scaled_ms = (delay.as_millis() as f64 * backoff.multiplier).max(1.0) as u64;
                delay = std::cmp::min(Duration::from_millis(scaled_ms), backoff.max_delay);
            }
        }
    }
}

async fn run_subscription_once(
    client: &MultiRpcClient,
    url: &str,
    served_by: &str,
    sender: &mpsc::Sender<ChainNotification>,
) -> Result<(), RpcError> {
    let (stream, _) = connect_async(url)
        .await
        .map_err(|err| RpcError::Transport {
            endpoint: url.to_owned(),
            source: anyhow_compat::AnyhowError(err.to_string()),
        })?;
    let (mut write, mut read) = stream.split();
    send_notification_subscriptions(&mut write, url).await?;

    loop {
        let message = tokio::select! {
            biased;
            _ = sender.closed() => return Ok(()),
            next = read.next() => match next {
                Some(message) => message.map_err(|err| RpcError::Transport {
                    endpoint: url.to_owned(),
                    source: anyhow_compat::AnyhowError(err.to_string()),
                })?,
                None => return Ok(()),
            },
        };

        let notifications = match message {
            Message::Text(text) => parse_ws_message(client, &text, served_by).await?,
            Message::Binary(bytes) => {
                let text = String::from_utf8(bytes.to_vec())
                    .map_err(|err| RpcError::MalformedResponse(err.to_string()))?;
                parse_ws_message(client, &text, served_by).await?
            }
            Message::Close(_) => return Ok(()),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => Vec::new(),
        };

        for notification in notifications {
            if sender.send(notification).await.is_err() {
                // Receiver dropped — caller doesn't want any more.
                return Ok(());
            }
        }
    }
}

pub async fn read_notifications_ws(
    client: &MultiRpcClient,
    url: &str,
    served_by: &str,
    max_messages: usize,
    idle_timeout_ms: u64,
) -> Result<Vec<ChainNotification>, RpcError> {
    let (stream, _) = connect_async(url)
        .await
        .map_err(|err| RpcError::Transport {
            endpoint: url.to_owned(),
            source: anyhow_compat::AnyhowError(err.to_string()),
        })?;
    let (mut write, mut read) = stream.split();
    send_notification_subscriptions(&mut write, url).await?;
    let mut notifications = Vec::new();

    loop {
        let next_message = if idle_timeout_ms == 0 {
            read.next().await
        } else {
            match tokio::time::timeout(Duration::from_millis(idle_timeout_ms), read.next()).await {
                Ok(message) => message,
                Err(_) => break,
            }
        };

        let Some(message) = next_message else {
            break;
        };

        let message = message.map_err(|err| RpcError::Transport {
            endpoint: url.to_owned(),
            source: anyhow_compat::AnyhowError(err.to_string()),
        })?;

        match message {
            Message::Text(text) => {
                notifications.extend(parse_ws_message(client, &text, served_by).await?);
            }
            Message::Binary(bytes) => {
                let text = String::from_utf8(bytes.to_vec())
                    .map_err(|err| RpcError::MalformedResponse(err.to_string()))?;
                notifications.extend(parse_ws_message(client, &text, served_by).await?);
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }

        if max_messages != 0 && notifications.len() >= max_messages {
            break;
        }
    }

    notifications.truncate(max_messages);
    Ok(notifications)
}

async fn send_notification_subscriptions<S>(
    write: &mut S,
    endpoint: &str,
) -> Result<(), RpcError>
where
    S: futures::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    for payload in [
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "notifyBlockAdded",
            "params": {
                "command": "start"
            }
        }),
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "notifyVirtualChainChanged",
            "params": {
                "includeAcceptedTransactionIds": false,
                "command": "start"
            }
        }),
    ] {
        write
            .send(Message::Text(payload.to_string().into()))
            .await
            .map_err(|err| RpcError::Transport {
                endpoint: endpoint.to_owned(),
                source: anyhow_compat::AnyhowError(err.to_string()),
            })?;
    }

    Ok(())
}

async fn parse_ws_message(
    client: &MultiRpcClient,
    text: &str,
    served_by: &str,
) -> Result<Vec<ChainNotification>, RpcError> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    if trimmed.lines().count() > 1 {
        return parse_notifications_jsonl(trimmed, served_by);
    }

    let value: Value =
        serde_json::from_str(trimmed).map_err(|err| RpcError::MalformedResponse(err.to_string()))?;

    match parse_chain_notification_envelope(value, served_by)? {
        ParsedNotification::Ready(notification) => Ok(vec![notification]),
        ParsedNotification::VirtualChainByHashes {
            removed_chain_block_hashes,
            added_chain_block_hashes,
        } => Ok(vec![ChainNotification::VirtualChainChanged {
            removed_chain_block_hashes,
            added_chain_blocks: client.fetch_blocks(&added_chain_block_hashes).await?,
        }]),
        ParsedNotification::SubscriptionAck => Ok(Vec::new()),
        ParsedNotification::SubscriptionRejected { message } => Err(RpcError::SubscriptionRejected {
            endpoint: served_by.to_owned(),
            message,
        }),
        ParsedNotification::Ignore => Ok(Vec::new()),
    }
}

enum ParsedNotification {
    Ready(ChainNotification),
    VirtualChainByHashes {
        removed_chain_block_hashes: Vec<String>,
        added_chain_block_hashes: Vec<String>,
    },
    SubscriptionAck,
    SubscriptionRejected { message: String },
    Ignore,
}

fn parse_chain_notification(value: Value, served_by: &str) -> Result<ChainNotification, RpcError> {
    match parse_chain_notification_envelope(value, served_by)? {
        ParsedNotification::Ready(notification) => Ok(notification),
        ParsedNotification::VirtualChainByHashes { .. } => Err(RpcError::MalformedResponse(
            "virtual-chain notification only provided block hashes".to_owned(),
        )),
        ParsedNotification::SubscriptionAck => Err(RpcError::MalformedResponse(
            "message only contained a subscription acknowledgement".to_owned(),
        )),
        ParsedNotification::SubscriptionRejected { message } => Err(RpcError::SubscriptionRejected {
            endpoint: served_by.to_owned(),
            message,
        }),
        ParsedNotification::Ignore => Err(RpcError::MalformedResponse(
            "message did not contain a chain notification".to_owned(),
        )),
    }
}

fn parse_chain_notification_envelope(
    value: Value,
    served_by: &str,
) -> Result<ParsedNotification, RpcError> {
    if let Some(kind) = value.get("kind").and_then(Value::as_str) {
        return parse_chain_notification_kind(kind, &value, served_by);
    }

    if let Some(method) = value.get("method").and_then(Value::as_str) {
        if let Some(kind) = normalize_notification_kind(method) {
            let payload = value
                .get("params")
                .or_else(|| value.get("result"))
                .unwrap_or(&value);
            return parse_chain_notification_kind(kind, payload, served_by);
        }

        return Ok(ParsedNotification::Ignore);
    }

    if let Some(event) = value.get("event").and_then(Value::as_str) {
        if let Some(kind) = normalize_notification_kind(event) {
            let payload = value.get("data").unwrap_or(&value);
            return parse_chain_notification_kind(kind, payload, served_by);
        }
    }

    if value.get("id").is_some() {
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| error.to_string());
            return Ok(ParsedNotification::SubscriptionRejected { message });
        }

        if value.get("result").is_some() {
            return Ok(ParsedNotification::SubscriptionAck);
        }
    }

    Err(RpcError::MalformedResponse(value.to_string()))
}

fn parse_chain_notification_kind(
    kind: &str,
    value: &Value,
    served_by: &str,
) -> Result<ParsedNotification, RpcError> {
    match kind {
        "BlockAdded" => Ok(ParsedNotification::Ready(ChainNotification::BlockAdded(
            parse_block_value(value.get("block").unwrap_or(value), served_by)?,
        ))),
        "VirtualChainChanged" => {
            let removed_chain_block_hashes = value
                .get("removedChainBlockHashes")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            if let Some(added_chain_blocks) = value.get("addedChainBlocks").and_then(Value::as_array)
            {
                return Ok(ParsedNotification::Ready(ChainNotification::VirtualChainChanged {
                    removed_chain_block_hashes,
                    added_chain_blocks: added_chain_blocks
                        .iter()
                        .map(|value| parse_block_value(value, served_by))
                        .collect::<Result<Vec<_>, _>>()?,
                }));
            }

            let added_chain_block_hashes = value
                .get("addedChainBlockHashes")
                .and_then(Value::as_array)
                .map(|values| {
                    values
                        .iter()
                        .filter_map(|value| value.as_str().map(ToOwned::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            Ok(ParsedNotification::VirtualChainByHashes {
                removed_chain_block_hashes,
                added_chain_block_hashes,
            })
        }
        "RecoveryRequired" => Ok(ParsedNotification::Ready(ChainNotification::RecoveryRequired {
            from_daa_score: value
                .get("fromDaaScore")
                .and_then(Value::as_u64)
                .ok_or_else(|| RpcError::MalformedResponse(value.to_string()))?,
            to_daa_score: value
                .get("toDaaScore")
                .and_then(Value::as_u64)
                .ok_or_else(|| RpcError::MalformedResponse(value.to_string()))?,
            reason: value
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("notification-stream")
                .to_owned(),
        })),
        _ => Err(RpcError::MalformedResponse(value.to_string())),
    }
}

fn normalize_notification_kind(raw: &str) -> Option<&'static str> {
    match raw {
        "BlockAdded" | "blockAdded" | "BlockAddedNotification" | "block-added" => {
            Some("BlockAdded")
        }
        "VirtualChainChanged"
        | "virtualChainChanged"
        | "VirtualChainChangedNotification"
        | "virtual-chain-changed" => Some("VirtualChainChanged"),
        "RecoveryRequired" | "recoveryRequired" | "recovery-required" => {
            Some("RecoveryRequired")
        }
        _ => None,
    }
}

fn parse_ingested_block(value: Value, served_by: &str) -> Result<IngestedBlock, RpcError> {
    let result = value
        .get("result")
        .ok_or_else(|| RpcError::MalformedResponse(value.to_string()))?;

    let mut block = parse_block_value(result.get("block").unwrap_or(result), served_by)?;
    if let Some(is_finalized) = result.get("isFinalized").and_then(Value::as_bool) {
        block.is_finalized = is_finalized;
    }
    Ok(block)
}

fn parse_block_value(value: &Value, served_by: &str) -> Result<IngestedBlock, RpcError> {
    let header = value.get("header").unwrap_or(value);

    let hash = extract_string(&[value.get("hash"), header.get("hash")], value)?;
    let daa_score = extract_u64(&[header.get("daaScore"), value.get("daaScore")], value)?;
    let blue_score = extract_u64(&[header.get("blueScore"), value.get("blueScore")], value)?;
    let is_finalized = value.get("isFinalized").and_then(Value::as_bool).unwrap_or(false);

    Ok(IngestedBlock {
        hash,
        daa_score,
        blue_score,
        is_finalized,
        served_by: served_by.to_owned(),
    })
}

fn extract_string(candidates: &[Option<&Value>], original: &Value) -> Result<String, RpcError> {
    for candidate in candidates {
        if let Some(value) = candidate.and_then(Value::as_str) {
            return Ok(value.to_owned());
        }
    }

    Err(RpcError::MalformedResponse(original.to_string()))
}

fn extract_u64(candidates: &[Option<&Value>], original: &Value) -> Result<u64, RpcError> {
    for candidate in candidates {
        if let Some(value) = candidate {
            if let Some(number) = value.as_u64() {
                return Ok(number);
            }
            if let Some(number) = value.as_str().and_then(|v| v.parse::<u64>().ok()) {
                return Ok(number);
            }
        }
    }

    Err(RpcError::MalformedResponse(original.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Arc};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::Mutex as TokioMutex,
    };
    use tokio_tungstenite::accept_async;

    #[derive(Clone)]
    enum MockBehavior {
        Healthy,
        BlockResponse {
            hash: &'static str,
            daa_score: u64,
            blue_score: u64,
            finalized: bool,
        },
        Malformed,
        Timeout(Duration),
    }

    async fn spawn_mock_rpc_server(behaviors: Vec<MockBehavior>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let shared = Arc::new(TokioMutex::new(VecDeque::from(behaviors)));

        tokio::spawn(async move {
            loop {
                let (mut socket, _) = listener.accept().await.unwrap();
                let shared = shared.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 8192];
                    let bytes_read = socket.read(&mut buf).await.unwrap();
                    if bytes_read == 0 {
                        return;
                    }

                    let body = String::from_utf8_lossy(&buf[..bytes_read]);
                    let request_json = body
                        .split("\r\n\r\n")
                        .nth(1)
                        .and_then(|part| serde_json::from_str::<Value>(part).ok())
                        .unwrap_or_else(|| json!({}));
                    let method = request_json
                        .get("method")
                        .and_then(Value::as_str)
                        .unwrap_or_default();

                    let behavior = {
                        let mut guard = shared.lock().await;
                        guard.pop_front().unwrap_or(MockBehavior::Healthy)
                    };

                    match behavior {
                        MockBehavior::Timeout(duration) => {
                            tokio::time::sleep(duration).await;
                        }
                        MockBehavior::Malformed => {
                            write_http_json(&mut socket, json!({"jsonrpc": "2.0", "id": 1, "result": {"block": {}}})).await;
                        }
                        MockBehavior::Healthy => {
                            let payload = match method {
                                "getBlockDagInfo" => json!({"jsonrpc": "2.0", "id": 1, "result": {"network": "kaspa-testnet"}}),
                                _ => json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}}),
                            };
                            write_http_json(&mut socket, payload).await;
                        }
                        MockBehavior::BlockResponse {
                            hash,
                            daa_score,
                            blue_score,
                            finalized,
                        } => {
                            let payload = json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "result": {
                                    "block": {
                                        "header": {
                                            "hash": hash,
                                            "daaScore": daa_score,
                                            "blueScore": blue_score
                                        }
                                    },
                                    "isFinalized": finalized
                                }
                            });
                            write_http_json(&mut socket, payload).await;
                        }
                    }
                });
            }
        });

        format!("http://{}", addr)
    }

    async fn spawn_mock_ws_server(messages: Vec<Value>) -> String {
        spawn_mock_ws_server_with_tail(messages, None).await
    }

    /// Mock ws server that accepts a series of sequential
    /// connections. For each connection it consumes the two
    /// subscribe messages, sends the connection's batch of
    /// payloads, then closes. After the last batch the listener
    /// stays open but does not accept more connections.
    async fn spawn_mock_ws_server_multi(batches: Vec<Vec<Value>>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            for batch in batches {
                let Ok((socket, _)) = listener.accept().await else {
                    return;
                };
                let Ok(mut ws) = accept_async(socket).await else {
                    continue;
                };

                // Drain the two subscribe messages.
                let _ = ws.next().await;
                let _ = ws.next().await;

                for message in batch {
                    if ws
                        .send(Message::Text(message.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
                let _ = ws.close(None).await;
            }
        });

        format!("ws://{}", addr)
    }

    /// Mock ws server that accepts one connection and stays open
    /// without ever sending a payload — used to test that the
    /// driver exits cleanly when the receiver is dropped while it
    /// is blocked on `read.next()`.
    async fn spawn_mock_ws_server_idle() -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let Ok((socket, _)) = listener.accept().await else {
                return;
            };
            let Ok(mut ws) = accept_async(socket).await else {
                return;
            };
            let _ = ws.next().await;
            let _ = ws.next().await;
            // Hold the connection open indefinitely.
            tokio::time::sleep(Duration::from_secs(60)).await;
            let _ = ws.close(None).await;
        });

        format!("ws://{}", addr)
    }

    async fn spawn_mock_ws_server_with_tail(
        messages: Vec<Value>,
        tail_sleep: Option<Duration>,
    ) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut ws = accept_async(socket).await.unwrap();

            let first = ws.next().await.unwrap().unwrap();
            let second = ws.next().await.unwrap().unwrap();

            let first_text = first.into_text().unwrap();
            let second_text = second.into_text().unwrap();
            let first_json: Value = serde_json::from_str(&first_text).unwrap();
            let second_json: Value = serde_json::from_str(&second_text).unwrap();

            assert_eq!(first_json.get("method").and_then(Value::as_str), Some("notifyBlockAdded"));
            assert_eq!(first_json.pointer("/params/command").and_then(Value::as_str), Some("start"));
            assert_eq!(second_json.get("method").and_then(Value::as_str), Some("notifyVirtualChainChanged"));
            assert_eq!(
                second_json
                    .pointer("/params/includeAcceptedTransactionIds")
                    .and_then(Value::as_bool),
                Some(false)
            );

            for message in messages {
                ws.send(Message::Text(message.to_string().into())).await.unwrap();
            }

            if let Some(duration) = tail_sleep {
                tokio::time::sleep(duration).await;
            }

            ws.close(None).await.unwrap();
        });

        format!("ws://{}", addr)
    }

    async fn write_http_json(socket: &mut tokio::net::TcpStream, payload: Value) {
        let body = payload.to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        socket.write_all(response.as_bytes()).await.unwrap();
    }

    fn endpoint(label: &str, url: String) -> RpcEndpoint {
        RpcEndpoint {
            label: label.to_owned(),
            url,
            timeout: Duration::from_millis(50),
        }
    }

    fn client(primary_url: String, backup_urls: Vec<String>) -> MultiRpcClient {
        MultiRpcClient::new(RpcClientConfig {
            primary: endpoint("primary", primary_url),
            backups: backup_urls
                .into_iter()
                .enumerate()
                .map(|(index, url)| endpoint(&format!("backup-{}", index + 1), url))
                .collect(),
            health_probe_interval: Duration::from_millis(10),
        })
    }

    #[tokio::test]
    async fn fails_over_to_backup_and_records_audit() {
        let primary = spawn_mock_rpc_server(vec![MockBehavior::Timeout(Duration::from_millis(150))]).await;
        let backup = spawn_mock_rpc_server(vec![MockBehavior::BlockResponse {
            hash: "backup-block",
            daa_score: 42,
            blue_score: 7,
            finalized: true,
        }])
        .await;
        let client = client(primary, vec![backup]);

        let block = client.fetch_block("backup-block").await.unwrap();
        assert_eq!(block.hash, "backup-block");
        assert_eq!(block.served_by, "backup-1");
        assert!(block.is_finalized);

        let audit = client.audit_log().await;
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].served_by, "backup-1");

        let health = client.endpoint_health().await;
        assert_eq!(health.get("primary"), Some(&false));
        assert_eq!(health.get("backup-1"), Some(&true));
    }

    #[tokio::test]
    async fn rotates_backup_order_between_calls() {
        let primary = spawn_mock_rpc_server(vec![
            MockBehavior::Timeout(Duration::from_millis(150)),
            MockBehavior::Timeout(Duration::from_millis(150)),
        ])
        .await;
        let backup_1 = spawn_mock_rpc_server(vec![MockBehavior::BlockResponse {
            hash: "block-a",
            daa_score: 10,
            blue_score: 1,
            finalized: true,
        }])
        .await;
        let backup_2 = spawn_mock_rpc_server(vec![MockBehavior::BlockResponse {
            hash: "block-b",
            daa_score: 11,
            blue_score: 2,
            finalized: false,
        }])
        .await;
        let client = client(primary, vec![backup_1, backup_2]);

        let first = client.fetch_block("block-a").await.unwrap();
        let second = client.fetch_block("block-b").await.unwrap();

        assert_eq!(first.served_by, "backup-1");
        assert_eq!(second.served_by, "backup-2");
    }

    #[tokio::test]
    async fn health_probe_marks_each_endpoint() {
        let healthy = spawn_mock_rpc_server(vec![MockBehavior::Healthy]).await;
        let unhealthy = spawn_mock_rpc_server(vec![MockBehavior::Timeout(Duration::from_millis(150))]).await;
        let client = client(healthy, vec![unhealthy]);

        let statuses = client.probe_health_once().await;
        assert_eq!(statuses.len(), 2);
        assert_eq!(
            statuses,
            vec![
                EndpointHealth {
                    endpoint: "primary".to_owned(),
                    healthy: true,
                },
                EndpointHealth {
                    endpoint: "backup-1".to_owned(),
                    healthy: false,
                },
            ]
        );

        let health = client.endpoint_health().await;
        assert_eq!(health.get("primary"), Some(&true));
        assert_eq!(health.get("backup-1"), Some(&false));
    }

    #[tokio::test]
    async fn malformed_block_response_is_reported() {
        let primary = spawn_mock_rpc_server(vec![MockBehavior::Malformed]).await;
        let client = client(primary, vec![]);

        let err = client.fetch_block("bad-block").await.unwrap_err();
        assert!(matches!(err, RpcError::MalformedResponse(_)));
    }

    #[tokio::test]
    async fn fetch_blocks_preserves_order() {
        let primary = spawn_mock_rpc_server(vec![
            MockBehavior::BlockResponse {
                hash: "block-a",
                daa_score: 1,
                blue_score: 1,
                finalized: false,
            },
            MockBehavior::BlockResponse {
                hash: "block-b",
                daa_score: 2,
                blue_score: 2,
                finalized: true,
            },
        ])
        .await;
        let client = client(primary, vec![]);

        let blocks = client.fetch_blocks(["block-a", "block-b"]).await.unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].hash, "block-a");
        assert_eq!(blocks[1].hash, "block-b");
    }

    #[tokio::test]
    async fn recover_blocks_by_hashes_builds_virtual_chain_notification() {
        let primary = spawn_mock_rpc_server(vec![
            MockBehavior::BlockResponse {
                hash: "block-a",
                daa_score: 9,
                blue_score: 1,
                finalized: false,
            },
            MockBehavior::BlockResponse {
                hash: "block-b",
                daa_score: 10,
                blue_score: 2,
                finalized: true,
            },
        ])
        .await;
        let client = client(primary, vec![]);

        let notification = client
            .recover_blocks_by_hashes(["block-a", "block-b"], 10, 10)
            .await
            .unwrap();
        match notification {
            ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes,
                added_chain_blocks,
            } => {
                assert!(removed_chain_block_hashes.is_empty());
                assert_eq!(added_chain_blocks.len(), 1);
                assert_eq!(added_chain_blocks[0].hash, "block-b");
            }
            other => panic!("unexpected notification: {other:?}"),
        }
    }

    #[test]
    fn parse_notifications_jsonl_reads_live_style_events() {
        let jsonl = r#"
{"kind":"BlockAdded","block":{"hash":"a","daaScore":1,"blueScore":1,"isFinalized":false}}
{"kind":"VirtualChainChanged","removedChainBlockHashes":["a"],"addedChainBlocks":[{"hash":"b","daaScore":2,"blueScore":2,"isFinalized":true}]}
{"kind":"RecoveryRequired","fromDaaScore":3,"toDaaScore":4,"reason":"gap"}
"#;
        let parsed = parse_notifications_jsonl(jsonl, "stream").unwrap();
        assert_eq!(parsed.len(), 3);
        match &parsed[0] {
            ChainNotification::BlockAdded(block) => {
                assert_eq!(block.hash, "a");
                assert_eq!(block.served_by, "stream");
            }
            other => panic!("unexpected first notification: {other:?}"),
        }
        match &parsed[1] {
            ChainNotification::VirtualChainChanged { removed_chain_block_hashes, added_chain_blocks } => {
                assert_eq!(removed_chain_block_hashes, &vec!["a".to_owned()]);
                assert_eq!(added_chain_blocks[0].hash, "b");
            }
            other => panic!("unexpected second notification: {other:?}"),
        }
    }

    #[test]
    fn parse_chain_notification_envelope_accepts_wasm_style_events() {
        let value = json!({
            "event": "block-added",
            "data": {
                "block": {
                    "header": {
                        "hash": "evt-a",
                        "daaScore": 11,
                        "blueScore": 12
                    },
                    "isFinalized": true
                }
            }
        });

        let parsed = parse_chain_notification(value, "stream").unwrap();
        match parsed {
            ChainNotification::BlockAdded(block) => {
                assert_eq!(block.hash, "evt-a");
                assert!(block.is_finalized);
            }
            other => panic!("unexpected notification: {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_notifications_ws_fails_fast_on_subscription_error() {
        let primary = spawn_mock_rpc_server(vec![]).await;
        let client = client(primary, vec![]);
        let ws_url = spawn_mock_ws_server(vec![json!({
            "jsonrpc":"2.0",
            "id":2,
            "error":{"message":"virtual chain subscriptions disabled"}
        })])
        .await;

        let err = client
            .read_notifications_ws(&ws_url, "wrpc", 8, 0)
            .await
            .unwrap_err();
        match err {
            RpcError::SubscriptionRejected { endpoint, message } => {
                assert_eq!(endpoint, "wrpc");
                assert!(message.contains("virtual chain subscriptions disabled"));
            }
            other => panic!("unexpected error: {other:?}"),
        }
    }

    #[tokio::test]
    async fn read_notifications_ws_subscribes_and_resolves_virtual_chain_hashes() {
        let primary = spawn_mock_rpc_server(vec![MockBehavior::BlockResponse {
            hash: "block-b",
            daa_score: 22,
            blue_score: 5,
            finalized: true,
        }])
        .await;
        let client = client(primary, vec![]);
        let ws_url = spawn_mock_ws_server(vec![
            json!({"jsonrpc":"2.0","id":1,"result":{}}),
            json!({"jsonrpc":"2.0","id":2,"result":{}}),
            json!({
                "method": "blockAdded",
                "params": {
                    "block": {
                        "header": {
                            "hash": "block-a",
                            "daaScore": 21,
                            "blueScore": 4
                        },
                        "isFinalized": false
                    }
                }
            }),
            json!({
                "method": "virtualChainChanged",
                "params": {
                    "removedChainBlockHashes": ["block-a"],
                    "addedChainBlockHashes": ["block-b"]
                }
            }),
        ])
        .await;

        let notifications = client
            .read_notifications_ws(&ws_url, "wrpc", 8, 0)
            .await
            .unwrap();
        assert_eq!(notifications.len(), 2);

        match &notifications[0] {
            ChainNotification::BlockAdded(block) => {
                assert_eq!(block.hash, "block-a");
                assert_eq!(block.served_by, "wrpc");
            }
            other => panic!("unexpected first notification: {other:?}"),
        }

        match &notifications[1] {
            ChainNotification::VirtualChainChanged {
                removed_chain_block_hashes,
                added_chain_blocks,
            } => {
                assert_eq!(removed_chain_block_hashes, &vec!["block-a".to_owned()]);
                assert_eq!(added_chain_blocks.len(), 1);
                assert_eq!(added_chain_blocks[0].hash, "block-b");
                assert_eq!(added_chain_blocks[0].served_by, "primary");
            }
            other => panic!("unexpected second notification: {other:?}"),
        }
    }

    #[tokio::test]
    async fn continuous_subscription_reconnects_after_server_disconnect() {
        let primary = spawn_mock_rpc_server(vec![]).await;
        let client = client(primary, vec![]);

        // Two batches → server accepts twice; each batch carries a
        // single fully-resolved BlockAdded so we don't need HTTP
        // fallback lookups in this test.
        let ws_url = spawn_mock_ws_server_multi(vec![
            vec![
                json!({"jsonrpc":"2.0","id":1,"result":{}}),
                json!({"jsonrpc":"2.0","id":2,"result":{}}),
                json!({
                    "method": "blockAdded",
                    "params": {
                        "block": {
                            "header": {"hash": "block-1", "daaScore": 1, "blueScore": 1},
                            "isFinalized": true
                        }
                    }
                }),
            ],
            vec![
                json!({"jsonrpc":"2.0","id":1,"result":{}}),
                json!({"jsonrpc":"2.0","id":2,"result":{}}),
                json!({
                    "method": "blockAdded",
                    "params": {
                        "block": {
                            "header": {"hash": "block-2", "daaScore": 2, "blueScore": 2},
                            "isFinalized": true
                        }
                    }
                }),
            ],
        ])
        .await;

        let (tx, mut rx) = mpsc::channel(16);
        let handle = client.spawn_continuous_subscription(
            ws_url,
            "wrpc".to_owned(),
            tx,
            SubscriptionBackoff {
                initial_delay: Duration::from_millis(25),
                max_delay: Duration::from_millis(100),
                multiplier: 2.0,
                max_attempts: 0,
            },
        );

        let mut got = Vec::new();
        for _ in 0..2 {
            let notification = tokio::time::timeout(Duration::from_secs(2), rx.recv())
                .await
                .expect("recv timeout")
                .expect("channel closed");
            got.push(notification);
        }

        drop(rx);
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;

        let hashes: Vec<&str> = got
            .iter()
            .filter_map(|n| match n {
                ChainNotification::BlockAdded(block) => Some(block.hash.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(hashes, vec!["block-1", "block-2"]);
    }

    #[tokio::test]
    async fn continuous_subscription_exits_when_receiver_is_dropped_mid_stream() {
        let primary = spawn_mock_rpc_server(vec![]).await;
        let client = client(primary, vec![]);
        let ws_url = spawn_mock_ws_server_idle().await;

        let (tx, rx) = mpsc::channel::<ChainNotification>(4);
        let handle = client.spawn_continuous_subscription(
            ws_url,
            "wrpc".to_owned(),
            tx,
            SubscriptionBackoff::default(),
        );

        // Receiver dropped immediately; driver should notice via
        // sender.closed() inside its select! and exit.
        drop(rx);

        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("driver did not exit after receiver was dropped")
            .expect("driver task panicked");
    }

    #[tokio::test]
    async fn continuous_subscription_gives_up_after_max_attempts() {
        let primary = spawn_mock_rpc_server(vec![]).await;
        let client = client(primary, vec![]);
        // No ws server at this URL — connect_async will fail every
        // attempt. With max_attempts = 2, the driver should give up
        // quickly.
        let unreachable = "ws://127.0.0.1:1".to_owned();

        let (tx, _rx) = mpsc::channel::<ChainNotification>(1);
        let handle = client.spawn_continuous_subscription(
            unreachable,
            "wrpc".to_owned(),
            tx,
            SubscriptionBackoff {
                initial_delay: Duration::from_millis(10),
                max_delay: Duration::from_millis(20),
                multiplier: 2.0,
                max_attempts: 2,
            },
        );

        tokio::time::timeout(Duration::from_secs(2), handle)
            .await
            .expect("driver did not exit after max_attempts")
            .expect("driver task panicked");
    }

    #[tokio::test]
    async fn read_notifications_ws_stops_after_idle_timeout_when_stream_stays_open() {
        let primary = spawn_mock_rpc_server(vec![]).await;
        let client = client(primary, vec![]);
        let ws_url = spawn_mock_ws_server_with_tail(
            vec![
                json!({"jsonrpc":"2.0","id":1,"result":{}}),
                json!({"jsonrpc":"2.0","id":2,"result":{}}),
            ],
            Some(Duration::from_millis(300)),
        )
        .await;

        let started = std::time::Instant::now();
        let notifications = client
            .read_notifications_ws(&ws_url, "wrpc", 0, 100)
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(notifications.is_empty());
    }
}
