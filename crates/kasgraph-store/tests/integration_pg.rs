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
    CommittedBlockRecord, CovenantLineageHead, CovenantLineageRow, CovenantSpendRecord,
    CovenantUtxoRecord, EntityVersionRecord, Krc20LegacyOpRecord, Krc721LegacyOpRecord,
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

/// `covenant_utxos_created_by_tx` returns exactly the covenant outputs a
/// transaction produced (the successor receipt set spend-operation
/// classification consumes), ordered by output index, and excludes other txs'.
#[sqlx::test]
async fn covenant_utxos_created_by_tx_returns_a_txs_outputs(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_utxo_by_tx").unwrap();
    store.ensure_subgraph_schema(&sg).await.unwrap();

    // Spend tx "txspend" produces two covenant receipts; an unrelated tx one.
    for (tx, idx, amt) in [
        ("txspend", 0i32, 600i64),
        ("txspend", 1, 400),
        ("other", 0, 999),
    ] {
        store
            .track_covenant_utxo(&CovenantUtxoRecord {
                subgraph: sg.clone(),
                tx_hash: tx.into(),
                output_index: idx,
                block_daa_score: 200,
                detector_kind: "KCC20Asset".into(),
                covenant_id: Some("cid-A".into()),
                value_sompi: amt,
                locked_state: serde_json::json!({ "amount": amt }),
            })
            .await
            .unwrap();
    }

    let created = store
        .covenant_utxos_created_by_tx(&sg, "txspend")
        .await
        .unwrap();
    assert_eq!(created.len(), 2, "only txspend's two outputs");
    // Ordered by output_index → 600 (idx 0) then 400 (idx 1).
    assert_eq!(created[0].value_sompi, 600);
    assert_eq!(created[1].value_sompi, 400);
    assert!(created.iter().all(|m| m.detector_kind == "KCC20Asset"));

    assert!(store
        .covenant_utxos_created_by_tx(&sg, "nonexistent")
        .await
        .unwrap()
        .is_empty());
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

/// KIP-20 lineage population + spend lifecycle: open a head, append a row,
/// the replay-idempotency guard (`covenant_lineage_row_exists`), the head
/// read-back, `covenant_lineage_continues` (driven by a tracked covenant
/// output of the spending tx), and the spend record + its DAA-scoped unwind.
#[sqlx::test]
async fn covenant_lineage_population_and_spend_lifecycle(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_lineage").unwrap();
    store.ensure_subgraph_schema(&sg).await.unwrap();

    // Genesis: a head at lineage_count 1 plus its seq-0 row.
    store
        .upsert_covenant_lineage_head(&CovenantLineageHead {
            covenant_id: "cid-A".into(),
            subgraph: sg.clone(),
            genesis_tx: "tx0".into(),
            current_utxo: "tx0:0".into(),
            last_seen_daa: 100,
            lineage_count: 1,
        })
        .await
        .unwrap();
    store
        .insert_covenant_lineage_row(&CovenantLineageRow {
            covenant_id: "cid-A".into(),
            subgraph: sg.clone(),
            seq: 0,
            tx_hash: "tx0".into(),
            output_index: 0,
            state_bytes: vec![1, 2, 3],
            daa_score: 100,
        })
        .await
        .unwrap();

    // The (covenant_id, tx_hash, output_index) step is the replay key.
    assert!(store
        .covenant_lineage_row_exists("cid-A", "tx0", 0)
        .await
        .unwrap());
    assert!(!store
        .covenant_lineage_row_exists("cid-A", "tx0", 9)
        .await
        .unwrap());

    let head = store
        .fetch_covenant_lineage_head("cid-A")
        .await
        .unwrap()
        .expect("head must exist");
    assert_eq!(head.lineage_count, 1);
    assert_eq!(head.current_utxo, "tx0:0");

    // A spend's successor resolves when the spending tx produced a tracked
    // covenant output of the same id (lineage continues).
    store
        .track_covenant_utxo(&CovenantUtxoRecord {
            subgraph: sg.clone(),
            tx_hash: "txspend".into(),
            output_index: 0,
            block_daa_score: 200,
            detector_kind: "OpenSilverVault".into(),
            covenant_id: Some("cid-A".into()),
            value_sompi: 1_000,
            locked_state: serde_json::json!({}),
        })
        .await
        .unwrap();
    assert!(store
        .covenant_lineage_continues(&sg, "txspend", "cid-A")
        .await
        .unwrap());
    assert!(!store
        .covenant_lineage_continues(&sg, "txspend", "cid-Z")
        .await
        .unwrap());

    // Record the spend; it is idempotent on the spending input and unwound
    // by the *spending* block's DAA.
    let spend = CovenantSpendRecord {
        subgraph: sg.clone(),
        spending_tx_hash: "txspend".into(),
        previous_tx_hash: "tx0".into(),
        previous_output_index: 0,
        block_daa_score: 200,
        detector_kind: "OpenSilverVault".into(),
        covenant_id: Some("cid-A".into()),
        spent_value_sompi: 1_000,
        successor_covenant_id: Some("cid-A".into()),
    };
    store.record_covenant_spend(&spend).await.unwrap();
    store.record_covenant_spend(&spend).await.unwrap(); // idempotent re-apply
    let removed = store.unwind_covenant_spends(&sg, 200).await.unwrap();
    assert_eq!(removed, 1, "idempotent record → exactly one spend row");
    Ok(())
}

/// The most intricate SQL in the store: `unwind_covenant_lineage` runs three
/// steps in one transaction — delete rows at/above the cutoff, drop heads
/// with no surviving row, and re-point each surviving head at its
/// highest-`seq` survivor. None of that is observable from a SQL string;
/// this exercises all three against a real server.
#[sqlx::test]
async fn covenant_lineage_reorg_unwinds_and_reanchors_heads(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_lineage_unwind").unwrap();

    // cid-A: a three-step lineage (genesis + two transitions), head at the tip.
    // The row→head foreign key requires the head to exist before its rows, so
    // open the head first (the node opens/advances the head per hit, then
    // appends the row).
    store
        .upsert_covenant_lineage_head(&CovenantLineageHead {
            covenant_id: "cid-A".into(),
            subgraph: sg.clone(),
            genesis_tx: "a0".into(),
            current_utxo: "a2:0".into(),
            last_seen_daa: 300,
            lineage_count: 3,
        })
        .await
        .unwrap();
    for (seq, tx, daa) in [(0i32, "a0", 100i64), (1, "a1", 200), (2, "a2", 300)] {
        store
            .insert_covenant_lineage_row(&CovenantLineageRow {
                covenant_id: "cid-A".into(),
                subgraph: sg.clone(),
                seq,
                tx_hash: tx.into(),
                output_index: 0,
                state_bytes: vec![seq as u8],
                daa_score: daa,
            })
            .await
            .unwrap();
    }

    // cid-B: a single genesis row at DAA 300, so the unwind orphans its head.
    store
        .upsert_covenant_lineage_head(&CovenantLineageHead {
            covenant_id: "cid-B".into(),
            subgraph: sg.clone(),
            genesis_tx: "b0".into(),
            current_utxo: "b0:0".into(),
            last_seen_daa: 300,
            lineage_count: 1,
        })
        .await
        .unwrap();
    store
        .insert_covenant_lineage_row(&CovenantLineageRow {
            covenant_id: "cid-B".into(),
            subgraph: sg.clone(),
            seq: 0,
            tx_hash: "b0".into(),
            output_index: 0,
            state_bytes: vec![0],
            daa_score: 300,
        })
        .await
        .unwrap();

    // Reorg at DAA 250 drops cid-A's seq-2 row and cid-B's only row.
    let removed = store.unwind_covenant_lineage(&sg, 250).await.unwrap();
    assert_eq!(removed, 2);

    // cid-A head re-anchors to the surviving tip (seq 1 @ DAA 200).
    let head_a = store
        .fetch_covenant_lineage_head("cid-A")
        .await
        .unwrap()
        .expect("cid-A head survives");
    assert_eq!(head_a.current_utxo, "a1:0");
    assert_eq!(head_a.last_seen_daa, 200);
    assert_eq!(head_a.lineage_count, 2);
    assert!(!store
        .covenant_lineage_row_exists("cid-A", "a2", 0)
        .await
        .unwrap());
    assert!(store
        .covenant_lineage_row_exists("cid-A", "a1", 0)
        .await
        .unwrap());

    // cid-B had no surviving row, so its head is dropped entirely.
    assert!(store
        .fetch_covenant_lineage_head("cid-B")
        .await
        .unwrap()
        .is_none());
    Ok(())
}

/// KRC-721 journal parity with the KRC-20 test: seq allocation, replay
/// guard, record→ordered-fetch round-trip (incl. a u64 token id overflowing
/// `i64`, the TEXT-column rationale), and DAA-cutoff unwind.
#[sqlx::test]
async fn legacy_krc721_journal_seq_exists_fetch_unwind(pool: PgPool) -> sqlx::Result<()> {
    let store = Store::from_pool(pool);
    let sg = SubgraphId::new("itest_krc721").unwrap();

    assert_eq!(store.next_krc721_legacy_seq("nft").await.unwrap(), 0);
    assert!(!store.krc721_legacy_op_exists("tx-mint").await.unwrap());

    let mint = Krc721LegacyOpRecord {
        subgraph: sg.clone(),
        tick: "nft".into(),
        tick_raw: "NFT".into(),
        accepting_block_hash: "bh-1".into(),
        seq: 0,
        accepting_daa_score: 100,
        tx_hash: "tx-mint".into(),
        op: "mint".into(),
        sender: "kaspa:addr1".into(),
        // u64 token id beyond i64::MAX — proves the TEXT column choice.
        token_id: Some("18446744073709551615".into()),
        recipient: None,
        metadata_uri: Some("ipfs://cid".into()),
        max_supply: None,
    };
    store.record_krc721_legacy_op(&mint).await.unwrap();

    assert!(store.krc721_legacy_op_exists("tx-mint").await.unwrap());
    assert_eq!(store.next_krc721_legacy_seq("nft").await.unwrap(), 1);

    let ops = store.fetch_krc721_legacy_ops_ordered(&sg).await.unwrap();
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0], mint, "write/read column mapping must round-trip");

    let removed = store.unwind_krc721_legacy_ledger(&sg, 100).await.unwrap();
    assert_eq!(removed, 1);
    assert!(store
        .fetch_krc721_legacy_ops_ordered(&sg)
        .await
        .unwrap()
        .is_empty());
    Ok(())
}
