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
//! POI = blake2b-256( prior_poi || canonical_block_bytes ).
//!
//! [`canonical_block_bytes`] defines the "sorted canonical" form: two
//! honest indexers that processed the same committed block must produce
//! byte-identical input here, so their POI chains agree and a third party
//! can verify either one. The canonical form is independent of how the
//! state is stored (Postgres JSONB does not preserve object-key order, so
//! the stored text is not canonical) — it is recomputed from the parsed
//! entity values.

use blake2::{digest::consts::U32, Blake2b, Digest};
use serde_json::Value;
use thiserror::Error;

pub type PoiHash = [u8; 32];

/// One entity's contribution to a block's canonical state: its type, its
/// id, and the JSON state the mapping wrote for it this block.
#[derive(Debug, Clone, PartialEq)]
pub struct CanonicalEntity {
    pub entity_type: String,
    pub entity_id: String,
    pub state: Value,
}

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

/// Canonical byte encoding of a block's indexed entity state, suitable as
/// the `canonical_entity_bytes` argument to [`compute_poi`].
///
/// Determinism is the whole point, so the encoding pins down every degree
/// of freedom:
///   - Entities are sorted by `(entity_type, entity_id)`, so the input
///     order the caller happened to collect them in is irrelevant.
///   - Each entity's JSON state is canonicalized via [`canonical_json`]
///     (object keys recursively sorted, compact form), so JSONB key-order
///     drift can't change the hash.
///   - Every field is length-prefixed (u32 little-endian) so two adjacent
///     fields can never be reinterpreted as a different split (e.g. type
///     `"ab"` + id `"c"` vs type `"a"` + id `"bc"`), and the entity count
///     is prefixed so a block with no state changes still hashes to a
///     well-defined, non-empty value (the chain advances every block).
pub fn canonical_block_bytes(entities: &[CanonicalEntity]) -> Vec<u8> {
    let mut sorted: Vec<&CanonicalEntity> = entities.iter().collect();
    sorted.sort_by(|a, b| {
        a.entity_type
            .cmp(&b.entity_type)
            .then_with(|| a.entity_id.cmp(&b.entity_id))
    });

    let mut out = Vec::new();
    out.extend_from_slice(&(sorted.len() as u32).to_le_bytes());
    for entity in sorted {
        push_field(&mut out, entity.entity_type.as_bytes());
        push_field(&mut out, entity.entity_id.as_bytes());
        push_field(&mut out, &canonical_json(&entity.state));
    }
    out
}

/// Canonical, compact JSON bytes for a value: object keys recursively
/// sorted so the encoding is independent of insertion / storage order.
/// Array order is preserved (it is semantically meaningful). Escaping and
/// number formatting are delegated to `serde_json`.
pub fn canonical_json(value: &Value) -> Vec<u8> {
    // Re-serializing a `Value` is infallible.
    serde_json::to_vec(&canonicalize_value(value)).expect("serializing a serde_json::Value")
}

fn canonicalize_value(value: &Value) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(canonicalize_value).collect()),
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut sorted = serde_json::Map::new();
            for key in keys {
                sorted.insert(key.clone(), canonicalize_value(&map[key]));
            }
            Value::Object(sorted)
        }
        other => other.clone(),
    }
}

fn push_field(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(bytes);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn entity(entity_type: &str, entity_id: &str, state: Value) -> CanonicalEntity {
        CanonicalEntity {
            entity_type: entity_type.to_string(),
            entity_id: entity_id.to_string(),
            state,
        }
    }

    #[test]
    fn canonical_json_sorts_object_keys_recursively() {
        let unsorted = json!({"b": 1, "a": {"y": 2, "x": 3}});
        let sorted = json!({"a": {"x": 3, "y": 2}, "b": 1});
        assert_eq!(canonical_json(&unsorted), canonical_json(&sorted));
        // Compact form, keys in sorted order.
        assert_eq!(canonical_json(&unsorted), br#"{"a":{"x":3,"y":2},"b":1}"#);
    }

    #[test]
    fn canonical_json_preserves_array_order() {
        // Array order is semantic, so it must NOT be sorted.
        assert_ne!(
            canonical_json(&json!([1, 2, 3])),
            canonical_json(&json!([3, 2, 1]))
        );
    }

    #[test]
    fn canonical_block_bytes_is_independent_of_input_order() {
        let a = entity("Bond", "b1", json!({"amount": "10"}));
        let b = entity("Bond", "b2", json!({"amount": "20"}));
        let c = entity("Holder", "h1", json!({"balance": "5"}));
        let one = canonical_block_bytes(&[a.clone(), b.clone(), c.clone()]);
        let two = canonical_block_bytes(&[c, a, b]);
        assert_eq!(one, two);
    }

    #[test]
    fn canonical_block_bytes_is_independent_of_payload_key_order() {
        let forward = entity("Bond", "b1", json!({"amount": "10", "owner": "x"}));
        let reverse = entity("Bond", "b1", json!({"owner": "x", "amount": "10"}));
        assert_eq!(
            canonical_block_bytes(&[forward]),
            canonical_block_bytes(&[reverse])
        );
    }

    #[test]
    fn length_prefixing_disambiguates_field_splits() {
        // type "ab" + id "c" must not collide with type "a" + id "bc".
        let left = entity("ab", "c", json!({}));
        let right = entity("a", "bc", json!({}));
        assert_ne!(
            canonical_block_bytes(&[left]),
            canonical_block_bytes(&[right])
        );
    }

    #[test]
    fn empty_block_canonicalizes_to_a_nonempty_count_prefix() {
        // A block with no entity changes still advances the POI chain, so
        // its canonical form must be non-empty and accepted by compute_poi.
        let bytes = canonical_block_bytes(&[]);
        assert_eq!(bytes, 0u32.to_le_bytes());
        assert!(compute_poi(&[0u8; 32], &bytes).is_ok());
    }

    #[test]
    fn distinct_block_state_yields_distinct_canonical_bytes() {
        let one = canonical_block_bytes(&[entity("Bond", "b1", json!({"v": 1}))]);
        let two = canonical_block_bytes(&[entity("Bond", "b1", json!({"v": 2}))]);
        assert_ne!(one, two);
    }
}
