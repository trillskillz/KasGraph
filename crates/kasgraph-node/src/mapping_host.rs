//! Bridge from committed detector hits into subgraph WASM mappings.
//!
//! A detector hit on a committed block describes a covenant that just
//! appeared on-chain. This module turns that hit into the typed event
//! the mapping runtime dispatches, seeds the handler's `store_get`
//! read-set from the indexer's committed entity snapshot, and converts
//! the entity ops the handler emits into DAA-stamped store records.
//!
//! The transformations here are pure and deterministic; the live ingest
//! loop owns the side-effecting parts (loading each subgraph's built
//! wasm, resolving the handler name from the manifest, and persisting the
//! returned records via `Store::upsert_entity_version`).

use kasgraph_detectors::DetectedPattern;
use kasgraph_mapping::{
    DispatchOutcome, EntitySnapshot, MappingError, MappingEvent, MappingRuntime,
};
use kasgraph_store::{EntityVersionRecord, SubgraphId};

/// Build the mapping event for a lock-time detector hit. The detector's
/// extracted fields become the event payload; the handler must match an
/// exported function on the subgraph's compiled wasm.
pub fn locked_mapping_event(
    hit: &DetectedPattern,
    block_daa_score: u64,
    block_hash: &str,
    handler: impl Into<String>,
) -> MappingEvent {
    MappingEvent {
        block_daa_score,
        block_hash: block_hash.to_string(),
        payload: hit.payload.clone(),
        handler: handler.into(),
    }
}

/// Convert a handler's emitted entity ops into versioned store records
/// stamped with the committed block's DAA score, ready for
/// `Store::upsert_entity_version`. A reorg unwinds them by the same score.
pub fn entity_versions(
    outcome: &DispatchOutcome,
    subgraph: &SubgraphId,
    block_daa_score: i64,
) -> Vec<EntityVersionRecord> {
    outcome
        .entity_ops
        .iter()
        .map(|op| EntityVersionRecord {
            subgraph: subgraph.clone(),
            entity_type: op.entity.clone(),
            entity_id: op.id.clone(),
            block_daa_score,
            payload: op.data.clone(),
        })
        .collect()
}

/// Dispatch one lock-time hit through a compiled subgraph mapping,
/// seeding the handler's `store_get` reads from `snapshot`, and return
/// the versioned records it produced alongside the raw outcome (logs +
/// fuel). Dispatch errors (trap, fuel exhaustion, ABI mismatch, malformed
/// op) propagate so the caller can decide how a bad mapping is handled.
pub fn dispatch_locked_hit(
    runtime: &MappingRuntime,
    hit: &DetectedPattern,
    block_daa_score: u64,
    block_hash: &str,
    handler: &str,
    subgraph: &SubgraphId,
    snapshot: &EntitySnapshot,
) -> Result<(Vec<EntityVersionRecord>, DispatchOutcome), MappingError> {
    let event = locked_mapping_event(hit, block_daa_score, block_hash, handler);
    let outcome = runtime.dispatch_with_entities(event, snapshot)?;
    let records = entity_versions(&outcome, subgraph, block_daa_score as i64);
    Ok((records, outcome))
}

#[cfg(test)]
mod tests {
    use super::*;
    use kasgraph_detectors::DetectorKind;
    use kasgraph_mapping::EntityOp;

    fn hit() -> DetectedPattern {
        DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: Some("cov-1".into()),
            tx_hash: "tx-1".into(),
            output_index: 0,
            payload: serde_json::json!({ "owner": "abcd" }),
        }
    }

    // A mapping whose handler reads the seeded ("Bond","b1") entity and
    // re-emits it, proving the snapshot reaches the guest and the emitted
    // op flows back out as a versioned record.
    const WAT: &str = r#"
        (module
          (import "kasgraph" "store_set" (func $store_set (param i32 i32)))
          (import "kasgraph" "store_get"
            (func $store_get (param i32 i32 i32 i32) (result i64)))
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "kasgraph_alloc") (param $len i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $heap))
            (global.set $heap (i32.add (global.get $heap) (local.get $len)))
            (local.get $p))
          (data (i32.const 0) "{\"entity\":\"Bond\",\"id\":\"b1\",\"data\":{\"n\":7}}")
          (data (i32.const 200) "Bond")
          (data (i32.const 210) "b1")
          (func (export "handleLock") (param i32 i32)
            (drop
              (call $store_get
                (i32.const 200) (i32.const 4) (i32.const 210) (i32.const 2)))
            (call $store_set (i32.const 0) (i32.const 42))))
    "#;

    #[test]
    fn locked_mapping_event_carries_payload_block_and_handler() {
        let ev = locked_mapping_event(&hit(), 99, "block-h", "handleLock");
        assert_eq!(ev.block_daa_score, 99);
        assert_eq!(ev.block_hash, "block-h");
        assert_eq!(ev.handler, "handleLock");
        assert_eq!(ev.payload, serde_json::json!({ "owner": "abcd" }));
    }

    #[test]
    fn entity_versions_stamp_every_op_with_subgraph_and_daa() {
        let subgraph = SubgraphId::new("krc20").unwrap();
        let outcome = DispatchOutcome {
            entity_ops: vec![
                EntityOp {
                    entity: "Asset".into(),
                    id: "a1".into(),
                    data: serde_json::json!({ "supply": 1 }),
                },
                EntityOp {
                    entity: "Holder".into(),
                    id: "h1".into(),
                    data: serde_json::json!({ "balance": 1 }),
                },
            ],
            ..Default::default()
        };
        let recs = entity_versions(&outcome, &subgraph, 1234);
        assert_eq!(recs.len(), 2);
        assert!(recs.iter().all(|r| r.subgraph == subgraph));
        assert!(recs.iter().all(|r| r.block_daa_score == 1234));
        assert_eq!(recs[0].entity_type, "Asset");
        assert_eq!(recs[0].entity_id, "a1");
        assert_eq!(recs[1].entity_type, "Holder");
        assert_eq!(recs[1].payload, serde_json::json!({ "balance": 1 }));
    }

    #[test]
    fn dispatch_locked_hit_seeds_snapshot_and_returns_versioned_records() {
        let runtime = MappingRuntime::from_wasm(WAT).unwrap();
        let subgraph = SubgraphId::new("kasbonds").unwrap();
        let mut snapshot = EntitySnapshot::new();
        snapshot.insert(("Bond".into(), "b1".into()), serde_json::json!({ "n": 1 }));

        let (recs, outcome) = dispatch_locked_hit(
            &runtime,
            &hit(),
            555,
            "block-h",
            "handleLock",
            &subgraph,
            &snapshot,
        )
        .unwrap();

        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].subgraph, subgraph);
        assert_eq!(recs[0].entity_type, "Bond");
        assert_eq!(recs[0].entity_id, "b1");
        assert_eq!(recs[0].block_daa_score, 555);
        assert_eq!(recs[0].payload, serde_json::json!({ "n": 7 }));
        assert!(outcome.fuel_consumed > 0);
    }

    #[test]
    fn dispatch_locked_hit_propagates_abi_mismatch_for_unknown_handler() {
        let runtime = MappingRuntime::from_wasm(WAT).unwrap();
        let subgraph = SubgraphId::new("kasbonds").unwrap();
        let err = dispatch_locked_hit(
            &runtime,
            &hit(),
            1,
            "b",
            "handleMissing",
            &subgraph,
            &EntitySnapshot::new(),
        )
        .unwrap_err();
        match err {
            MappingError::AbiMismatch(msg) => assert!(msg.contains("handleMissing")),
            other => panic!("expected AbiMismatch, got {other:?}"),
        }
    }
}
