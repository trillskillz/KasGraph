//! kasgraph-poi — Proof-of-indexing.
//!
//! Per `PLAN.md` Phase 2.8:
//!   - Per-block hash of indexed state.
//!   - Stored alongside indexed data.
//!   - Allows third parties to verify indexer correctness.
//!   - Foundation for future decentralization (Phase 9.3).
//!
//! Hash function choice: blake2b-256 — matches the function the
//! kaspa-txscript engine uses elsewhere, so verifiers don't import a
//! second hash dependency.
//!
//! POI = blake2b-256( prior_poi || sorted_canonical_entity_state ).
//! "Sorted canonical" is defined per subgraph in Phase 2.8 — the
//! current scaffold accepts pre-canonicalized bytes.

use blake2::{digest::consts::U32, Blake2b, Digest};
use thiserror::Error;

pub type PoiHash = [u8; 32];

#[derive(Debug, Error)]
pub enum PoiError {
    #[error("entity bytes are empty — POI requires at least one entity slot")]
    EmptyEntityBytes,
}

/// Compute the POI for a block given the prior POI and the
/// canonicalized entity-state bytes for this block.
///
/// `prior_poi` is `[0u8; 32]` at genesis.
pub fn compute_poi(
    prior_poi: &PoiHash,
    canonical_entity_bytes: &[u8],
) -> Result<PoiHash, PoiError> {
    if canonical_entity_bytes.is_empty() {
        return Err(PoiError::EmptyEntityBytes);
    }
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(prior_poi);
    hasher.update(canonical_entity_bytes);
    let out = hasher.finalize();
    let mut poi = [0u8; 32];
    poi.copy_from_slice(&out);
    Ok(poi)
}

/// Hex-encode a POI for human-readable surfaces (logs, GraphQL
/// queries, status pages).
pub fn poi_hex(poi: &PoiHash) -> String {
    hex::encode(poi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_entity_bytes_rejected() {
        let prior = [0u8; 32];
        assert!(matches!(
            compute_poi(&prior, &[]),
            Err(PoiError::EmptyEntityBytes)
        ));
    }

    #[test]
    fn deterministic_chain() {
        let prior = [0u8; 32];
        let a = compute_poi(&prior, b"block-1-state").unwrap();
        let b = compute_poi(&a, b"block-2-state").unwrap();
        let c = compute_poi(&prior, b"block-1-state").unwrap();
        let d = compute_poi(&c, b"block-2-state").unwrap();
        // Same inputs → same chain hash.
        assert_eq!(a, c);
        assert_eq!(b, d);
        // Different prior → different result. (Trivially: a != b
        // because their priors differ. Same canonical bytes.)
        let alt = compute_poi(&b, b"block-1-state").unwrap();
        assert_ne!(a, alt);
    }

    #[test]
    fn hex_encoding_round_trips_via_length() {
        let prior = [0u8; 32];
        let poi = compute_poi(&prior, b"some-state").unwrap();
        // blake2b-256 → 32 bytes → 64 hex chars.
        assert_eq!(poi_hex(&poi).len(), 64);
    }
}
