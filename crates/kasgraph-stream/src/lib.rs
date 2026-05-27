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
//! This crate now exposes a real publish/subscribe hub backed by
//! `tokio::sync::broadcast`. The gRPC transport (tonic vs grpcio)
//! still lands later — that's the wire format. The hub is the
//! in-process primitive everything else (GraphQL subscriptions,
//! MCP streams, the gRPC server) plugs into.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::broadcast;

/// What a consumer is interested in. Multiple filters can be combined
/// on one subscription; the stream emits any event matching any
/// filter (OR semantics).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum StreamFilter {
    /// Watch a specific KIP-20 covenant id (hex). Receives every
    /// transition in that lineage.
    CovenantId(String),
    /// Watch every output matching an OpenSilver pattern, by pattern id
    /// (e.g. `OpenSilverVault` — the `DetectorKind` discriminant).
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

#[derive(Debug, Error)]
pub enum StreamError {
    #[error("stream closed: publisher dropped")]
    Closed,
    /// Slow subscriber missed events because the broadcast channel
    /// dropped them. `lagged_by` is the number of events skipped.
    /// The subscription is still usable.
    #[error("subscriber lagged behind by {lagged_by} events")]
    Lagged { lagged_by: u64 },
}

/// In-process publish/subscribe hub. Cheap to `clone()` — all clones
/// share the same broadcast channel, so any clone can `publish` and
/// any consumer can `subscribe` from any clone.
#[derive(Debug, Clone)]
pub struct StreamHub {
    tx: broadcast::Sender<StreamEvent>,
}

impl StreamHub {
    /// Create a new hub with `capacity` slots per subscriber.
    /// Subscribers that fall more than `capacity` events behind
    /// observe `StreamError::Lagged` on their next read.
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        Self { tx }
    }

    /// Number of currently-attached subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.tx.receiver_count()
    }

    /// Subscribe with `filters`. Empty `filters` matches nothing
    /// (every event is dropped at the filter boundary) — the typical
    /// shape is to either provide at least one filter or include
    /// `StreamFilter::All` to receive every event.
    pub fn subscribe(&self, filters: Vec<StreamFilter>) -> StreamSubscription {
        StreamSubscription {
            rx: self.tx.subscribe(),
            filters,
        }
    }

    /// Publish an event to every attached subscriber. Subscribers
    /// whose filters do not match the event will simply skip it on
    /// their side. Returns the number of subscribers the event was
    /// sent to (whether or not their filters matched).
    pub fn publish(&self, event: StreamEvent) -> usize {
        match self.tx.send(event) {
            Ok(n) => n,
            // No active receivers — that's not an error for a
            // pub/sub hub. Just no-op.
            Err(_) => 0,
        }
    }
}

/// One subscription. Wraps a `broadcast::Receiver` plus the filter
/// list; `recv` only yields events that match.
pub struct StreamSubscription {
    rx: broadcast::Receiver<StreamEvent>,
    filters: Vec<StreamFilter>,
}

impl StreamSubscription {
    /// Wait for the next matching event. Returns
    /// `Err(StreamError::Closed)` if the hub was dropped, or
    /// `Err(StreamError::Lagged { lagged_by })` if the subscriber
    /// fell behind capacity (the subscription is still usable after
    /// a `Lagged` error; the next `recv` resumes from the current
    /// head).
    pub async fn recv(&mut self) -> Result<StreamEvent, StreamError> {
        loop {
            match self.rx.recv().await {
                Ok(event) => {
                    if event_matches_any(&event, &self.filters) {
                        return Ok(event);
                    }
                    // Filter dropped — wait for the next.
                }
                Err(broadcast::error::RecvError::Closed) => return Err(StreamError::Closed),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    return Err(StreamError::Lagged { lagged_by: n });
                }
            }
        }
    }

    /// Non-blocking variant: returns `Ok(Some(event))` if a matching
    /// event is immediately available, `Ok(None)` if nothing is
    /// waiting, or an error on close / lag. Useful for select-driven
    /// pollers and tests.
    pub fn try_recv(&mut self) -> Result<Option<StreamEvent>, StreamError> {
        loop {
            match self.rx.try_recv() {
                Ok(event) => {
                    if event_matches_any(&event, &self.filters) {
                        return Ok(Some(event));
                    }
                }
                Err(broadcast::error::TryRecvError::Empty) => return Ok(None),
                Err(broadcast::error::TryRecvError::Closed) => return Err(StreamError::Closed),
                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                    return Err(StreamError::Lagged { lagged_by: n });
                }
            }
        }
    }
}

fn event_matches_any(event: &StreamEvent, filters: &[StreamFilter]) -> bool {
    filters.iter().any(|f| event_matches(event, f))
}

fn event_matches(event: &StreamEvent, filter: &StreamFilter) -> bool {
    match filter {
        StreamFilter::All => true,
        StreamFilter::CovenantId(id) => payload_string(event, "covenant_id") == Some(id.as_str()),
        StreamFilter::OpenSilverPattern(pattern) => event.kind == *pattern,
        StreamFilter::Krc20Ticker(ticker) => payload_string(event, "tick") == Some(ticker.as_str()),
        StreamFilter::Address(addr) => {
            // Any of the standard address-bearing payload keys.
            const ADDRESS_FIELDS: &[&str] = &[
                "address",
                "sender",
                "recipient",
                "owner",
                "owner_pubkey",
                "beneficiary",
                "to",
                "from",
                "holder",
                "holder_pubkey",
            ];
            ADDRESS_FIELDS
                .iter()
                .any(|key| payload_string(event, key) == Some(addr.as_str()))
        }
    }
}

fn payload_string<'a>(event: &'a StreamEvent, key: &str) -> Option<&'a str> {
    event.payload.get(key).and_then(|v| v.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(kind: &str, payload: serde_json::Value) -> StreamEvent {
        StreamEvent {
            block_daa_score: 1,
            block_hash: "h".to_owned(),
            kind: kind.to_owned(),
            payload,
        }
    }

    #[test]
    fn all_filter_matches_every_event() {
        let e = event("OpenSilverVault", json!({}));
        assert!(event_matches(&e, &StreamFilter::All));
    }

    #[test]
    fn covenant_id_filter_matches_by_payload_field() {
        let e = event("KCC20Asset", json!({"covenant_id": "0xabc"}));
        assert!(event_matches(
            &e,
            &StreamFilter::CovenantId("0xabc".to_owned())
        ));
        assert!(!event_matches(
            &e,
            &StreamFilter::CovenantId("0xdef".to_owned())
        ));
    }

    #[test]
    fn open_silver_pattern_filter_matches_by_kind() {
        let e = event("OpenSilverVault", json!({}));
        assert!(event_matches(
            &e,
            &StreamFilter::OpenSilverPattern("OpenSilverVault".to_owned())
        ));
        assert!(!event_matches(
            &e,
            &StreamFilter::OpenSilverPattern("OpenSilverEscrowBilateral".to_owned())
        ));
    }

    #[test]
    fn krc20_ticker_filter_matches_payload_tick() {
        let e = event("Krc20Transfer", json!({"tick": "KASP"}));
        assert!(event_matches(
            &e,
            &StreamFilter::Krc20Ticker("KASP".to_owned())
        ));
        assert!(!event_matches(
            &e,
            &StreamFilter::Krc20Ticker("nope".to_owned())
        ));
    }

    #[test]
    fn address_filter_matches_any_known_address_field() {
        let e = event(
            "Transfer",
            json!({"sender": "kaspa:abc", "recipient": "kaspa:def"}),
        );
        assert!(event_matches(
            &e,
            &StreamFilter::Address("kaspa:abc".to_owned())
        ));
        assert!(event_matches(
            &e,
            &StreamFilter::Address("kaspa:def".to_owned())
        ));
        assert!(!event_matches(
            &e,
            &StreamFilter::Address("kaspa:ghi".to_owned())
        ));
    }

    #[test]
    fn empty_filter_list_drops_every_event() {
        let e = event("OpenSilverVault", json!({}));
        assert!(!event_matches_any(&e, &[]));
    }

    #[tokio::test]
    async fn publish_to_no_subscribers_is_no_op() {
        let hub = StreamHub::new(8);
        let count = hub.publish(event("X", json!({})));
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn publish_delivers_matching_event_to_subscriber() {
        let hub = StreamHub::new(8);
        let mut sub = hub.subscribe(vec![StreamFilter::All]);
        hub.publish(event("OpenSilverVault", json!({"covenant_id": "id-1"})));

        let got = sub.recv().await.unwrap();
        assert_eq!(got.kind, "OpenSilverVault");
    }

    #[tokio::test]
    async fn subscriber_with_non_matching_filter_does_not_receive() {
        let hub = StreamHub::new(8);
        let mut sub = hub.subscribe(vec![StreamFilter::CovenantId("0xabc".to_owned())]);
        hub.publish(event("OpenSilverVault", json!({"covenant_id": "0xdef"})));
        hub.publish(event("OpenSilverVault", json!({"covenant_id": "0xabc"})));

        let got = sub.recv().await.unwrap();
        assert_eq!(got.payload["covenant_id"], "0xabc");

        assert!(matches!(sub.try_recv(), Ok(None)));
    }

    #[tokio::test]
    async fn multi_filter_is_or_semantics() {
        let hub = StreamHub::new(8);
        let mut sub = hub.subscribe(vec![
            StreamFilter::Krc20Ticker("KASP".to_owned()),
            StreamFilter::OpenSilverPattern("OpenSilverVault".to_owned()),
        ]);

        hub.publish(event("Krc20Transfer", json!({"tick": "KASP"})));
        hub.publish(event("OpenSilverVault", json!({"covenant_id": "x"})));
        hub.publish(event("Krc721Transfer", json!({"tick": "OTHER"})));

        assert_eq!(sub.recv().await.unwrap().kind, "Krc20Transfer");
        assert_eq!(sub.recv().await.unwrap().kind, "OpenSilverVault");
        assert!(matches!(sub.try_recv(), Ok(None)));
    }

    #[tokio::test]
    async fn slow_subscriber_observes_lagged_error_then_resumes() {
        let hub = StreamHub::new(2);
        let mut sub = hub.subscribe(vec![StreamFilter::All]);

        // Publish more events than the channel capacity without
        // draining; the next recv must surface Lagged.
        for i in 0..5 {
            hub.publish(event("X", json!({"i": i})));
        }

        match sub.recv().await {
            Err(StreamError::Lagged { lagged_by }) => {
                assert!(lagged_by >= 1, "expected positive lag, got {lagged_by}");
            }
            other => panic!("expected Lagged, got {other:?}"),
        }

        // After Lagged the subscription is still usable, but there
        // may still be retained backlog in the broadcast buffer.
        // Drain whatever survived so the next fresh publish can be
        // asserted deterministically.
        loop {
            match sub.try_recv() {
                Ok(Some(_)) => continue,
                Ok(None) => break,
                Err(StreamError::Lagged { .. }) => continue,
                Err(other) => panic!("unexpected stream error while draining backlog: {other:?}"),
            }
        }

        hub.publish(event("Y", json!({"i": 99})));
        let got = sub.recv().await.unwrap();
        assert_eq!(got.kind, "Y");
    }

    #[tokio::test]
    async fn dropping_hub_closes_active_subscriptions() {
        let hub = StreamHub::new(4);
        let mut sub = hub.subscribe(vec![StreamFilter::All]);
        drop(hub);
        assert!(matches!(sub.recv().await, Err(StreamError::Closed)));
    }

    #[tokio::test]
    async fn subscriber_count_tracks_live_subscriptions() {
        let hub = StreamHub::new(4);
        assert_eq!(hub.subscriber_count(), 0);
        let _a = hub.subscribe(vec![StreamFilter::All]);
        let _b = hub.subscribe(vec![StreamFilter::All]);
        assert_eq!(hub.subscriber_count(), 2);
        drop(_a);
        assert_eq!(hub.subscriber_count(), 1);
    }
}
