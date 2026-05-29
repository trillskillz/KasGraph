//! Real-Postgres integration coverage for `kasgraph-store`.
//!
//! The crate's unit tests pin the *shape* of every SQL builder (column
//! order, `ON CONFLICT`, schema interpolation) without a database. These
//! tests close the remaining gap: they run the queries against a live
//! Postgres, so the migrations, the per-subgraph schema bootstrap, and —
//! most importantly — the reorg-unwind semantics the whole BlockDAG model
//! depends on are exercised end to end rather than asserted as strings.
//!
//! Gated behind the `integration-pg` feature so the default
//! `cargo test --workspace` (and CI, which has no Postgres) compiles this
//! file to nothing. `#[sqlx::test]` provisions a fresh database per test
//! and runs `./migrations` into it, reading the server from `DATABASE_URL`.
//! Run with:
//!   DATABASE_URL=postgres://kasgraph:kasgraph@127.0.0.1:5434/kasgraph \
//!     cargo test -p kasgraph-store --features integration-pg
#![cfg(feature = "integration-pg")]

use kasgraph_store::{
    CommittedBlockRecord, CovenantUtxoRecord, EntityVersionRecord, Krc20LegacyOpRecord,
    PoiCheckpoint, Store, SubgraphId,
};
use serde_json::json;
use sqlx::PgPool;

/// `#[sqlx::test]` runs `./migrations` before handing us the pool, so every
/// migration must apply cleanly against a real server (previously only the
/// SQL text was ever inspected). Assert the base tables actually exist.
#[sqlx::test]
async fn migrations_apply_and_base_tables_exist(pool: PgPool) -> sqlx::Result<()> {
    for table in [
        "kasgraph_poi",
        "kasgraph_committed_block",
        "kasgraph_reorg_audit",
        "kasgraph_rpc_block_audit",
        "kasgraph_covenant_lineage_head",
        "kasgraph_covenant_lineage_row",
        "kasgraph_detected_pattern",
        "kasgraph_krc20_legacy_ledger",
        "kasgraph_krc721_legacy_ledger",
    ] {
        let regclass: Option<String> = sqlx::query_scalar("SELECT to_regclass($1)::text")
            .bind(table)
            .fetch_one(&pool)
            .await?;
        assert_eq!(regclass.as_deref(), Some(table), "missing table {table}");
    }
    Ok(())
}

/// The core of the wasm-dispatch persistence loop: a mapping emits entity
/// versions stamped by DAA score, and a reorg unwinds exactly the versions
/// at or above the rolled-back height so the survivor becomes current.
#[sqlx::test]
async fn entity_version_roundtrip_and_reorg_unwind(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_entities").unwrap();
    store.ensure_subgraph_schema(&sg).await.unwrap();

    let v1 = EntityVersionRecord {
        subgraph: sg.clone(),
        entity_type: "Bond".into(),
        entity_id: "b1".into(),
        block_daa_score: 100,
        payload: json!({ "state": "locked", "v": 1 }),
    };
    let v2 = EntityVersionRecord {
        block_daa_score: 200,
        payload: json!({ "state": "active", "v": 2 }),
        ..v1.clone()
    };
    store.upsert_entity_version(&v1).await.unwrap();
    store.upsert_entity_version(&v2).await.unwrap();

    // latest = highest DAA; snapshot = one row per key at its latest.
    assert_eq!(
        store.latest_entity(&sg, "Bond", "b1").await.unwrap(),
        Some(json!({ "state": "active", "v": 2 }))
    );
    let snapshot = store.snapshot_entities(&sg).await.unwrap();
    assert_eq!(snapshot.len(), 1);
    assert_eq!(snapshot[0].entity_id, "b1");
    assert_eq!(snapshot[0].payload, json!({ "state": "active", "v": 2 }));

    // Reorg drops the version committed at/above 200; the v1 survivor is current again.
    let removed = store.unwind_entity_versions(&sg, 200).await.unwrap();
    assert_eq!(removed, 1);
    assert_eq!(
        store.latest_entity(&sg, "Bond", "b1").await.unwrap(),
        Some(json!({ "state": "locked", "v": 1 }))
    );

    // Idempotent re-apply of the same (type,id,daa) overwrites, never duplicates.
    store.upsert_entity_version(&v1).await.unwrap();
    assert_eq!(store.snapshot_entities(&sg).await.unwrap().len(), 1);
    Ok(())
}

/// A `CovenantLocked` hit tracks an outpoint so a later spend of it is
/// recognized; a reorg of the lock block drops the tracker entry.
#[sqlx::test]
async fn covenant_utxo_track_lookup_unwind(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_utxo").unwrap();
    store.ensure_subgraph_schema(&sg).await.unwrap();

    store
        .track_covenant_utxo(&CovenantUtxoRecord {
            subgraph: sg.clone(),
            tx_hash: "txlock".into(),
            output_index: 0,
            block_daa_score: 100,
            detector_kind: "OpenSilverVault".into(),
            covenant_id: Some("cid-1".into()),
            value_sompi: 5_000_000,
            locked_state: json!({ "amount": "5000000" }),
        })
        .await
        .unwrap();

    let hit = store
        .lookup_covenant_utxo(&sg, "txlock", 0)
        .await
        .unwrap()
        .expect("the tracked outpoint must be found");
    assert_eq!(hit.detector_kind, "OpenSilverVault");
    assert_eq!(hit.covenant_id, Some("cid-1".into()));
    assert_eq!(hit.value_sompi, 5_000_000);
    assert_eq!(hit.locked_state, json!({ "amount": "5000000" }));

    // A different output index is an ordinary (non-covenant) UTXO.
    assert!(store
        .lookup_covenant_utxo(&sg, "txlock", 1)
        .await
        .unwrap()
        .is_none());

    let removed = store.unwind_covenant_utxos(&sg, 100).await.unwrap();
    assert_eq!(removed, 1);
    assert!(store
        .lookup_covenant_utxo(&sg, "txlock", 0)
        .await
        .unwrap()
        .is_none());
    Ok(())
}

/// The legacy-KRC-20 journal: per-tick `seq` allocation, the replay guard,
/// the ordered read that feeds `Krc20Ledger::replay`, and reorg unwind. The
/// round-trip also proves the write/read column mappings agree against a
/// real row (the unit tests only check each builder's SQL text).
#[sqlx::test]
async fn legacy_krc20_journal_seq_exists_fetch_unwind(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_krc20").unwrap();

    assert_eq!(store.next_krc20_legacy_seq("abc").await.unwrap(), 0);
    assert!(!store.krc20_legacy_op_exists("tx-deploy").await.unwrap());

    let deploy = Krc20LegacyOpRecord {
        subgraph: sg.clone(),
        tick: "abc".into(),
        tick_raw: "ABC".into(),
        accepting_block_hash: "bh-1".into(),
        seq: 0,
        accepting_daa_score: 100,
        tx_hash: "tx-deploy".into(),
        op: "deploy".into(),
        sender: "kaspa:addr1".into(),
        recipient: None,
        // u64 max-supply that overflows i64, proving the TEXT column choice.
        amount: None,
        max_supply: Some("18446744073709551615".into()),
        mint_limit: Some("1000".into()),
    };
    store.record_krc20_legacy_op(&deploy).await.unwrap();

    assert!(store.krc20_legacy_op_exists("tx-deploy").await.unwrap());
    assert_eq!(store.next_krc20_legacy_seq("abc").await.unwrap(), 1);

    let ops = store.fetch_krc20_legacy_ops_ordered(&sg).await.unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0], deploy, "write/read column mapping must round-trip");

    let removed = store.unwind_krc20_legacy_ledger(&sg, 100).await.unwrap();
    assert_eq!(removed, 1);
    assert!(store
        .fetch_krc20_legacy_ops_ordered(&sg)
        .await
        .unwrap()
        .is_empty());
    Ok(())
}

/// POI checkpoints, committed-block tracking, and the reorg unwind that
/// deletes the rolled-back POI rows so the surviving checkpoint re-anchors
/// the hash chain (`latest_poi_for_subgraph`). This is the durability half
/// of the `BLOCKDAG_REORG_SEMANTICS` contract.
#[sqlx::test]
async fn poi_and_committed_block_reorg_reanchor(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_poi").unwrap();

    for (daa, byte, hash) in [(100i64, 1u8, "bh-100"), (200, 2, "bh-200")] {
        store
            .insert_poi_checkpoint(&PoiCheckpoint {
                subgraph: sg.clone(),
                block_daa_score: daa,
                poi_hash: [byte; 32],
            })
            .await
            .unwrap();
        store
            .record_committed_block(&CommittedBlockRecord {
                subgraph: sg.clone(),
                block_hash: hash.into(),
                daa_score: daa,
                served_by: "node-a".into(),
            })
            .await
            .unwrap();
    }

    let latest = store.latest_poi_for_subgraph(&sg).await.unwrap().unwrap();
    assert_eq!(latest.block_daa_score, 200);
    assert_eq!(latest.poi_hash, [2u8; 32]);

    // A removed-chain notification drops the tip block; its POI goes with it.
    let report = store
        .unwind_committed_blocks_for_subgraph(&sg, &["bh-200".into()], "integration reorg")
        .await
        .unwrap();
    assert_eq!(report.removed_hashes, vec!["bh-200".to_string()]);
    assert!(report.audit_id > 0, "an audit row must record the unwind");

    // The surviving checkpoint re-anchors the chain.
    let latest = store.latest_poi_for_subgraph(&sg).await.unwrap().unwrap();
    assert_eq!(latest.block_daa_score, 100);
    assert_eq!(latest.poi_hash, [1u8; 32]);
    Ok(())
}
