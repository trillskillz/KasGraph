//! kasgraph-detectors — Built-in pattern detection for KasGraph.
//!
//! Per `PLAN.md` Phase 2.5: subgraphs do NOT write detection code.
//! They subscribe to typed events emitted by these detectors.
//!
//! Detector kinds:
//!   - OpenSilver patterns (Vault, Escrow, MultiSig, Vesting,
//!     StreamingPayment, AtomicSwap, DeadMansSwitch, SocialRecovery,
//!     FreelancePayroll, Ownable, TimeLock)
//!   - KCC20 (native KRC-20 post-Toccata) — asset + four controllers
//!   - ZK-aware family (verified-computation, private-asset-transfer,
//!     oracle, proof-stitched multi-pattern)
//!   - KRC721 collections + individual NFTs
//!   - KasBonds bonds (first dogfooding customer)
//!
//! Detectors operate on parsed redeem scripts. Each emits a
//! `DetectedPattern` event that the mapping runtime routes to
//! subgraph handlers.
//!
//! # Fingerprint model
//!
//! A pattern's compiled redeem script is mostly fixed bytes (the
//! entry-point logic) interspersed with per-instance state (owner
//! pubkey, paused flag, remaining allowance, vesting schedule, …).
//! A [`Fingerprint`] captures the canonical bytes and the
//! `masked_windows` that vary per instance. Matching ignores the
//! masked bytes; extraction pulls them out as named fields.
//!
//! Real OpenSilver compiled-script bytes wire into the
//! [`registry`] without touching the engine.

pub mod fingerprint;
pub mod registry;

pub use fingerprint::{Fingerprint, MaskedWindow};

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// What we look for. Extensible — adding a variant requires adding a
/// matcher entry in [`registry::all`] and a unit test.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum DetectorKind {
    // OpenSilver covenant patterns. The OpenSilver SDK exposes
    // canonical compiled scripts; KasGraph fingerprints those to
    // recognise instances on-chain.
    OpenSilverOwnable,
    OpenSilverMultisig,
    OpenSilverTimeLock,
    OpenSilverVault,
    OpenSilverEscrowBilateral,
    OpenSilverEscrowMilestone,
    OpenSilverStreamingPayment,
    OpenSilverVesting,
    OpenSilverDeadMansSwitch,
    OpenSilverSocialRecovery,
    OpenSilverAtomicSwapHTLC,
    OpenSilverFreelancePayroll,

    // Native KRC-20 (post-Toccata).
    KCC20Asset,
    KCC20OwnableController,
    KCC20PausableController,
    KCC20CappedController,
    KCC20VestingController,

    // ZK-aware family.
    ZkVerifiedComputation,
    ZkPrivateAssetTransfer,
    ZkVerifiedOracle,
    ZkVerifiedOracleV2,
    ZkProofStitchedMultiPattern,

    // Legacy / non-covenant. Still indexed but with different
    // detection heuristics (inscription-envelope parsing).
    Krc721Collection,
    Krc721Nft,

    // First dogfooding customer.
    KasBondsBond,
}

/// What a detector emits when it matches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedPattern {
    pub kind: DetectorKind,
    /// KIP-20 covenant ID for the matched UTXO, hex-encoded. Stable
    /// across the covenant's lineage — same id across every spend.
    pub covenant_id: Option<String>,
    /// Transaction hash where the match was observed, hex-encoded.
    pub tx_hash: String,
    /// Output index inside that transaction.
    pub output_index: u32,
    /// Detector-specific structured payload (entry-point name, state
    /// fields decoded from the redeem script, etc.). Keys come from
    /// the matching fingerprint's `masked_windows[*].field` names.
    pub payload: serde_json::Value,
}

/// Detector pipeline entry point. Walks the registry; returns every
/// matching pattern (a single redeem script could legitimately match
/// more than one fingerprint — e.g. a KCC20 asset that also matches
/// a generic Ownable wrapper).
pub fn detect_in_output(
    redeem_script_bytes: &[u8],
    tx_hash: &str,
    output_index: u32,
) -> Vec<DetectedPattern> {
    let mut hits = Vec::new();
    for entry in registry::all() {
        if let Some(payload) = entry.fingerprint.match_and_extract(redeem_script_bytes) {
            hits.push(DetectedPattern {
                kind: entry.kind,
                covenant_id: None,
                tx_hash: tx_hash.to_owned(),
                output_index,
                payload: payload_to_json(payload),
            });
        }
    }
    hits
}

fn payload_to_json(payload: BTreeMap<&'static str, Vec<u8>>) -> serde_json::Value {
    let mut map = serde_json::Map::with_capacity(payload.len());
    for (field, bytes) in payload {
        map.insert(
            field.to_owned(),
            serde_json::Value::String(hex::encode(bytes)),
        );
    }
    serde_json::Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_in_output_returns_empty_for_non_matching_script() {
        let hits = detect_in_output(&[0x00, 0x01, 0x02], "deadbeef", 0);
        assert!(hits.is_empty());
    }

    #[test]
    fn detect_in_output_returns_hit_for_known_pattern() {
        // Use the OpenSilverOwnable canonical bytes from the registry;
        // splice an arbitrary owner pubkey into the masked window so
        // matching still succeeds.
        let entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .expect("OpenSilverOwnable registered");
        let mut script = entry.fingerprint.bytes.clone();
        for w in &entry.fingerprint.masked_windows {
            for i in 0..w.len {
                script[w.offset + i] = 0xAB;
            }
        }
        let hits = detect_in_output(&script, "abc123", 7);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, DetectorKind::OpenSilverOwnable);
        assert_eq!(hits[0].tx_hash, "abc123");
        assert_eq!(hits[0].output_index, 7);
        // Payload contains the masked field as hex.
        let payload = hits[0].payload.as_object().expect("payload is object");
        assert!(!payload.is_empty());
    }

    #[test]
    fn unrelated_script_with_correct_length_does_not_match() {
        let entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .unwrap();
        let script = vec![0xFFu8; entry.fingerprint.bytes.len()];
        let hits = detect_in_output(&script, "tx", 0);
        // Could match if every fixed byte coincidentally is 0xFF; the
        // canonical bytes start with 0x01, so this collides only if
        // the registry was changed. Asserting no Ownable hit catches
        // accidental over-matching.
        assert!(hits
            .iter()
            .all(|h| h.kind != DetectorKind::OpenSilverOwnable));
    }
}
