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

use std::path::{Path, PathBuf};

use kasgraph_detectors::DetectedPattern;
use kasgraph_mapping::{
    DispatchOutcome, EntitySnapshot, MappingError, MappingEvent, MappingRuntime,
};
use kasgraph_store::{EntityVersionRecord, SubgraphId};
use serde::Serialize;
use tracing::warn;

use crate::subgraph_manifest::{BuildDescriptor, ManifestError, EVENT_COVENANT_LOCKED};

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

/// The protocol-observable envelope for a covenant spend, matching the
/// `CovenantSpend` interface the CLI codegen emits. These fields come from
/// the spend transaction plus the KIP-20 lineage tracker, so they stay
/// honest even when the locked covenant's pattern isn't registered.
/// Subgraph-specific quantities (token amounts, balances) are derived by
/// the mapping, not carried here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CovenantSpend {
    /// The covenant operation the spend performed (protocol-defined).
    pub operation: String,
    /// Value moved by the spend, in sompi, as a decimal string (matches
    /// the codegen type, which avoids JS number precision loss).
    pub spent_value_sompi: String,
    /// The covenant id this spend rolled forward into, or `None` when the
    /// spend terminates the lineage (a final redeem/burn).
    pub successor_covenant_id: Option<String>,
}

/// Build the mapping event for a `CovenantSpent` transition. The payload is
/// `{ "spend": <CovenantSpend>, "state": <prior locked state> }`, mirroring
/// the `{ spend; state }` shape the codegen types for spend handlers. The
/// prior locked state is the detector payload captured when the covenant was
/// locked (the indexer holds it on the lineage head / committed hit row).
#[allow(dead_code)]
pub fn spend_mapping_event(
    spend: &CovenantSpend,
    prior_state: serde_json::Value,
    block_daa_score: u64,
    block_hash: &str,
    handler: impl Into<String>,
) -> MappingEvent {
    MappingEvent {
        block_daa_score,
        block_hash: block_hash.to_string(),
        payload: serde_json::json!({ "spend": spend, "state": prior_state }),
        handler: handler.into(),
    }
}

/// Dispatch one spend transition through a compiled subgraph mapping,
/// seeding the handler's `store_get` reads from `snapshot`, and return the
/// versioned records it produced alongside the raw outcome. Symmetric to
/// [`dispatch_locked_hit`] but for the `CovenantSpent` event; dispatch
/// errors propagate so the caller decides how a bad mapping is handled.
#[allow(dead_code)]
pub fn dispatch_spend_hit(
    runtime: &MappingRuntime,
    spend: &CovenantSpend,
    prior_state: serde_json::Value,
    block_daa_score: u64,
    block_hash: &str,
    handler: &str,
    subgraph: &SubgraphId,
    snapshot: &EntitySnapshot,
) -> Result<(Vec<EntityVersionRecord>, DispatchOutcome), MappingError> {
    let event = spend_mapping_event(spend, prior_state, block_daa_score, block_hash, handler);
    let outcome = runtime.dispatch_with_entities(event, snapshot)?;
    let records = entity_versions(&outcome, subgraph, block_daa_score as i64);
    Ok((records, outcome))
}

#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(transparent)]
    Manifest(#[from] ManifestError),
    #[error("failed to read mapping wasm {path}: {source}")]
    ReadWasm {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to compile mapping wasm {path}: {source}")]
    Compile { path: PathBuf, source: MappingError },
}

/// A subgraph's compiled mapping plus its resolved descriptor, loaded
/// once at startup. The live ingest loop holds one per configured
/// subgraph and dispatches each committed block's detector hits through it.
pub struct LoadedMapping {
    pub subgraph: SubgraphId,
    pub descriptor: BuildDescriptor,
    pub runtime: MappingRuntime,
}

impl LoadedMapping {
    /// Load `<dir>/build/manifest.json` and the wasm it names, compiling
    /// the mapping runtime once.
    pub fn load(subgraph: SubgraphId, dir: impl AsRef<Path>) -> Result<Self, LoadError> {
        let dir = dir.as_ref().to_path_buf();
        let descriptor = BuildDescriptor::load(&dir)?;
        let wasm_path = descriptor.wasm_path(&dir);
        let bytes = std::fs::read(&wasm_path).map_err(|source| LoadError::ReadWasm {
            path: wasm_path.clone(),
            source,
        })?;
        let runtime = MappingRuntime::from_wasm(&bytes).map_err(|source| LoadError::Compile {
            path: wasm_path,
            source,
        })?;
        Ok(Self {
            subgraph,
            descriptor,
            runtime,
        })
    }

    /// Dispatch every lock-time detector hit on a committed block, seeding
    /// `store_get` reads from `snapshot`, and return the entity-version
    /// records to persist. A hit with no matching handler is skipped; a
    /// handler that fails is logged and skipped so one bad mapping cannot
    /// stall the indexer.
    pub fn dispatch_committed_hits(
        &self,
        block_daa_score: u64,
        block_hash: &str,
        hits: &[DetectedPattern],
        snapshot: &EntitySnapshot,
    ) -> Vec<EntityVersionRecord> {
        let mut records = Vec::new();
        for hit in hits {
            let kind = format!("{:?}", hit.kind);
            let Some(handler) = self
                .descriptor
                .resolve_handler(&kind, EVENT_COVENANT_LOCKED)
            else {
                continue;
            };
            match dispatch_locked_hit(
                &self.runtime,
                hit,
                block_daa_score,
                block_hash,
                handler,
                &self.subgraph,
                snapshot,
            ) {
                Ok((recs, _outcome)) => records.extend(recs),
                Err(e) => warn!(
                    subgraph = self.subgraph.schema_name(),
                    detector_kind = kind,
                    handler,
                    block_hash,
                    error = %e,
                    "mapping handler failed on committed hit; skipping"
                ),
            }
        }
        records
    }
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

    fn loaded(patterns: &str) -> LoadedMapping {
        let json = format!(
            r#"{{ "name":"t", "wasm":"t.wasm", "dataSources":[
              {{ "name":"d", "kind":"covenant_id", "patterns":[{patterns}],
                 "collection":null, "addresses":[],
                 "handlers":[{{"event":"CovenantLocked","handler":"handleLock"}}] }} ]}}"#
        );
        LoadedMapping {
            subgraph: SubgraphId::new("kasbonds").unwrap(),
            descriptor: BuildDescriptor::from_json(&json).unwrap(),
            runtime: MappingRuntime::from_wasm(WAT).unwrap(),
        }
    }

    #[test]
    fn dispatch_committed_hits_resolves_handler_and_collects_records() {
        // hit().kind is OpenSilverOwnable → matches the descriptor pattern.
        let lm = loaded("\"OpenSilverOwnable\"");
        let mut snapshot = EntitySnapshot::new();
        snapshot.insert(("Bond".into(), "b1".into()), serde_json::json!({ "n": 1 }));

        let recs = lm.dispatch_committed_hits(7, "blk", &[hit()], &snapshot);
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].entity_type, "Bond");
        assert_eq!(recs[0].block_daa_score, 7);
        assert_eq!(recs[0].payload, serde_json::json!({ "n": 7 }));
    }

    #[test]
    fn dispatch_committed_hits_skips_a_hit_no_data_source_matches() {
        // Descriptor patterns don't include OpenSilverOwnable.
        let lm = loaded("\"OpenSilverMultisig\"");
        let recs = lm.dispatch_committed_hits(7, "blk", &[hit()], &EntitySnapshot::new());
        assert!(recs.is_empty());
    }

    fn spend() -> CovenantSpend {
        CovenantSpend {
            operation: "transfer".into(),
            spent_value_sompi: "100000000".into(),
            successor_covenant_id: Some("cov-2".into()),
        }
    }

    #[test]
    fn spend_mapping_event_wraps_spend_and_prior_state() {
        let ev = spend_mapping_event(
            &spend(),
            serde_json::json!({ "owner": "abcd" }),
            42,
            "block-h",
            "handleSpent",
        );
        assert_eq!(ev.block_daa_score, 42);
        assert_eq!(ev.block_hash, "block-h");
        assert_eq!(ev.handler, "handleSpent");
        // CovenantSpend serializes camelCase under the `spend` key, with the
        // prior locked state preserved verbatim under `state`.
        assert_eq!(
            ev.payload,
            serde_json::json!({
                "spend": {
                    "operation": "transfer",
                    "spentValueSompi": "100000000",
                    "successorCovenantId": "cov-2"
                },
                "state": { "owner": "abcd" }
            })
        );
    }

    #[test]
    fn spend_mapping_event_emits_null_successor_when_lineage_terminates() {
        let terminal = CovenantSpend {
            operation: "burn".into(),
            spent_value_sompi: "0".into(),
            successor_covenant_id: None,
        };
        let ev = spend_mapping_event(&terminal, serde_json::Value::Null, 1, "b", "handleSpent");
        assert_eq!(
            ev.payload["spend"]["successorCovenantId"],
            serde_json::Value::Null
        );
    }

    #[test]
    fn dispatch_spend_hit_seeds_snapshot_and_returns_versioned_records() {
        // Reuses the WAT handler (it ignores the payload), proving the spend
        // path drives dispatch + snapshot seeding identically to the locked path.
        let runtime = MappingRuntime::from_wasm(WAT).unwrap();
        let subgraph = SubgraphId::new("kasbonds").unwrap();
        let mut snapshot = EntitySnapshot::new();
        snapshot.insert(("Bond".into(), "b1".into()), serde_json::json!({ "n": 1 }));

        let (recs, outcome) = dispatch_spend_hit(
            &runtime,
            &spend(),
            serde_json::json!({ "owner": "abcd" }),
            777,
            "block-h",
            "handleLock",
            &subgraph,
            &snapshot,
        )
        .unwrap();

        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].entity_type, "Bond");
        assert_eq!(recs[0].block_daa_score, 777);
        assert_eq!(recs[0].payload, serde_json::json!({ "n": 7 }));
        assert!(outcome.fuel_consumed > 0);
    }

    #[test]
    fn load_is_not_found_when_descriptor_is_missing() {
        match LoadedMapping::load(
            SubgraphId::new("kasbonds").unwrap(),
            "/nonexistent/subgraph/dir",
        ) {
            Err(LoadError::Manifest(ManifestError::NotFound(_))) => {}
            Err(other) => panic!("expected NotFound, got {other:?}"),
            Ok(_) => panic!("expected load to fail for a missing descriptor"),
        }
    }
}

/// Real-Postgres coverage for the *node* end of the dispatch loop: load a
/// subgraph's compiled mapping from disk via [`LoadedMapping::load`], build
/// the `store_get` read-set from `Store::snapshot_entities`, dispatch a
/// committed detector hit, persist the emitted entity versions with
/// `Store::upsert_entity_version`, and unwind them on reorg — exactly the
/// sequence the live ingest loop in `main.rs` runs, which until now had only
/// ever been exercised with an in-memory snapshot and no database.
///
/// Gated behind `integration-pg` (off by default) so `cargo test --workspace`
/// and CI stay green without Postgres. `#[sqlx::test]` provisions a fresh DB
/// per test and runs the `kasgraph-store` migrations into it, reading the
/// server from `DATABASE_URL`. Run with:
///   DATABASE_URL=postgres://kasgraph:kasgraph@127.0.0.1:5434/kasgraph \
///     cargo test -p kasgraph-node --features integration-pg
#[cfg(all(test, feature = "integration-pg"))]
mod integration_pg_tests {
    use super::*;
    use kasgraph_detectors::DetectorKind;
    use kasgraph_mapping::EntitySnapshot;
    use kasgraph_store::{EntityVersionRecord, Store};
    use serde_json::json;
    use sqlx::PgPool;
    use std::path::PathBuf;

    // A mapping whose `handleLock` reads the seeded ("Bond","b1") entity and
    // emits a `Bond/b1` op **only when `store_get` hits** (returns non-zero).
    // Branching on the result is what makes this prove the Postgres-sourced
    // snapshot actually reaches and steers the guest — a miss emits nothing.
    const GATED_WAT: &str = r#"
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
            (if (i64.ne
                  (call $store_get
                    (i32.const 200) (i32.const 4) (i32.const 210) (i32.const 2))
                  (i64.const 0))
              (then (call $store_set (i32.const 0) (i32.const 42))))))
    "#;

    fn hit() -> DetectedPattern {
        DetectedPattern {
            kind: DetectorKind::OpenSilverOwnable,
            covenant_id: Some("cov-1".into()),
            tx_hash: "tx-1".into(),
            output_index: 0,
            payload: json!({ "owner": "abcd" }),
        }
    }

    /// Write a loadable subgraph build dir (`build/manifest.json` +
    /// `build/mapping.wasm`) so the test exercises the real on-disk
    /// `LoadedMapping::load` path. The WAT is written as the wasm file;
    /// wasmtime's `Module::new` parses WAT text, so no `asc` toolchain is
    /// needed (the example mappings' own wasm is already ABI-checked by the
    /// TS `examples-build.test.ts` suite — what's unverified is this loop).
    fn write_fixture(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "kasgraph_nodeit_{tag}_{}_{nanos}",
            std::process::id()
        ));
        let build = dir.join("build");
        std::fs::create_dir_all(&build).unwrap();
        let manifest = r#"{ "name":"itest", "wasm":"mapping.wasm", "dataSources":[
            { "name":"d", "kind":"covenant_id", "patterns":["OpenSilverOwnable"],
              "collection":null, "addresses":[],
              "handlers":[{"event":"CovenantLocked","handler":"handleLock"}] } ]}"#;
        std::fs::write(build.join("manifest.json"), manifest).unwrap();
        std::fs::write(build.join("mapping.wasm"), GATED_WAT).unwrap();
        dir
    }

    #[sqlx::test(migrations = "../kasgraph-store/migrations")]
    async fn committed_dispatch_persists_entity_then_reorg_unwinds(pool: PgPool) -> sqlx::Result<()> {
        let store = Store::from_pool(pool);
        let sg = SubgraphId::new("itest_node_hit").unwrap();
        store.ensure_subgraph_schema(&sg).await.unwrap();

        // Prior committed state at DAA 50 — what a reorg of block 100 restores.
        store
            .upsert_entity_version(&EntityVersionRecord {
                subgraph: sg.clone(),
                entity_type: "Bond".into(),
                entity_id: "b1".into(),
                block_daa_score: 50,
                payload: json!({ "n": 1 }),
            })
            .await
            .unwrap();

        // Build the store_get read-set from Postgres exactly as the ingest loop does.
        let mut snapshot = EntitySnapshot::new();
        for row in store.snapshot_entities(&sg).await.unwrap() {
            snapshot.insert((row.entity_type, row.entity_id), row.payload);
        }
        assert_eq!(snapshot.len(), 1, "snapshot must be seeded from Postgres");

        let dir = write_fixture("hit");
        let lm = LoadedMapping::load(sg.clone(), &dir).unwrap();

        // The guest emits a Bond/b1 op *because* store_get hit on the seeded entity.
        let recs = lm.dispatch_committed_hits(100, "blk-100", &[hit()], &snapshot);
        assert_eq!(recs.len(), 1, "store_get hit → one emitted entity version");
        assert_eq!(recs[0].entity_type, "Bond");
        assert_eq!(recs[0].block_daa_score, 100);
        for r in &recs {
            store.upsert_entity_version(r).await.unwrap();
        }

        // The dispatched version is now the entity's current state.
        assert_eq!(
            store.latest_entity(&sg, "Bond", "b1").await.unwrap(),
            Some(json!({ "n": 7 }))
        );

        // A reorg of block 100 unwinds the dispatched version; the DAA-50 survivor returns.
        let removed = store.unwind_entity_versions(&sg, 100).await.unwrap();
        assert_eq!(removed, 1);
        assert_eq!(
            store.latest_entity(&sg, "Bond", "b1").await.unwrap(),
            Some(json!({ "n": 1 }))
        );

        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }

    #[sqlx::test(migrations = "../kasgraph-store/migrations")]
    async fn committed_dispatch_emits_nothing_on_snapshot_miss(pool: PgPool) -> sqlx::Result<()> {
        let store = Store::from_pool(pool);
        let sg = SubgraphId::new("itest_node_miss").unwrap();
        store.ensure_subgraph_schema(&sg).await.unwrap();

        // Empty snapshot → the guest's store_get misses → it emits nothing.
        let snapshot = EntitySnapshot::new();
        let dir = write_fixture("miss");
        let lm = LoadedMapping::load(sg.clone(), &dir).unwrap();

        let recs = lm.dispatch_committed_hits(100, "blk-100", &[hit()], &snapshot);
        assert!(recs.is_empty(), "store_get miss → guest emits no op");
        assert!(
            store.snapshot_entities(&sg).await.unwrap().is_empty(),
            "nothing dispatched, nothing persisted"
        );

        std::fs::remove_dir_all(&dir).ok();
        Ok(())
    }
}
