//! kasgraph-stream — Real-time streaming primitive.
//!
//! Per `PLAN.md` Phase 3.3:
//!   - Substreams-style architecture for sub-second latency consumers.
//!   - Block-by-block event stream over gRPC.
//!   - Consumers subscribe to specific data sources (Covenant IDs,
//!     OpenSilver patterns, KRC-20 tickers, addresses).
//!   - Backpressure-aware.
//!   - Used by latency-sensitive applications (trading dashboards,
//!     real-time wallets, MEV-style scanners).
//!
//! gRPC transport choice (tonic vs grpcio) is decided when the gRPC
//! schema lands in Phase 3.3. This crate currently exposes the typed
//! filter shape consumers will use to subscribe.

use serde::{Deserialize, Serialize};

/// What a consumer is interested in. Multiple filters can be combined
/// on one subscription; the stream emits any event matching any
/// filter (OR semantics).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamFilter {
    /// Watch a specific KIP-20 covenant id (hex). Receives every
    /// transition in that lineage.
    CovenantId(String),
    /// Watch every output matching an OpenSilver pattern, by pattern id
    /// (e.g. `core.vault`).
    OpenSilverPattern(String),
    /// Watch every transfer / mint of a native KRC-20 ticker.
    Krc20Ticker(String),
    /// Watch every event involving a specific address (sender, receiver,
    /// covenant signer).
    Address(String),
    /// Catch-all: every block, every event. Use sparingly.
    All,
}

/// One event delivered to a consumer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub block_daa_score: u64,
    pub block_hash: String,
    /// Detector kind that produced this event, as a string (matches
    /// the `DetectorKind` discriminants in `kasgraph-detectors`).
    pub kind: String,
    pub payload: serde_json::Value,
}
