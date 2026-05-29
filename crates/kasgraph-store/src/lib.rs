//! kasgraph-store — Postgres adapter for KasGraph.
//!
//! Each deployed subgraph lives in its own Postgres schema. POI
//! checkpoints (`kasgraph_poi`) live in a shared schema so third
//! parties can verify cross-subgraph indexer state.
//!
//! Per `PLAN.md`:
//!   - Phase 2.4: KIP-20 Covenant ID lineage tracker — first-class
//!     entity tracked from genesis. `covenantId` is a first-class
//!     field on every UTXO entity.
//!   - Phase 2.7: ZK proof + witness data indexing. Proofs in
//!     Postgres, witness data in object storage; this crate owns the
//!     Postgres side.
//!   - Phase 2.8: POI per-block hash of indexed state.

use sqlx::{postgres::PgPoolOptions, PgPool};
use thiserror::Error;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("database connection failure: {0}")]
    Connection(String),

    #[error("schema for subgraph `{0}` not initialized")]
    SchemaMissing(String),

    #[error("invalid subgraph id `{0}`: only ASCII lowercase letters, numbers, and underscores are allowed")]
    InvalidSubgraphId(String),

    #[error(
        "POI mismatch for subgraph `{subgraph}` at block {block}: expected {expected}, got {got}"
    )]
    PoiMismatch {
        subgraph: String,
        block: u64,
        expected: String,
        got: String,
    },

    #[error("database query failure: {0}")]
    Query(String),
}

/// Identifies a subgraph in the multi-tenant store. The id is also
/// the Postgres schema name; collisions are forbidden.
#[derive(Debug, Clone, Eq, PartialEq, Hash)]
pub struct SubgraphId(pub String);

impl SubgraphId {
    pub fn new(value: impl Into<String>) -> Result<Self, StoreError> {
        let value = value.into();
        if value.is_empty()
            || !value
                .chars()
                .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
        {
            return Err(StoreError::InvalidSubgraphId(value));
        }
        Ok(Self(value))
    }

    pub fn schema_name(&self) -> &str {
        &self.0
    }
}

/// Per-block proof-of-indexing checkpoint. Foundation for future
/// decentralization (Phase 9.3) and immediate verifiability (Phase 2.8).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoiCheckpoint {
    pub subgraph: SubgraphId,
    /// DAA score of the block this POI commits to.
    pub block_daa_score: i64,
    /// blake2b-256 over (sorted-entity-state || prior-POI).
    pub poi_hash: [u8; 32],
}

/// Current head row for a KIP-20 covenant lineage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CovenantLineageHead {
    pub covenant_id: String,
    pub subgraph: SubgraphId,
    pub genesis_tx: String,
    pub current_utxo: String,
    pub last_seen_daa: i64,
    pub lineage_count: i32,
}

/// Append-only per-transition lineage row for a covenant id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CovenantLineageRow {
    pub covenant_id: String,
    pub subgraph: SubgraphId,
    pub seq: i32,
    pub tx_hash: String,
    pub output_index: i32,
    pub state_bytes: Vec<u8>,
    pub daa_score: i64,
}

/// Audit record for which RPC endpoint served a block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcBlockAuditRecord {
    pub block_hash: String,
    pub daa_score: i64,
    pub served_by: String,
}

/// A committed block written into a subgraph's POI/audit history.
/// Recorded so that a later removed-chain notification can find and
/// delete the right rows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedBlockRecord {
    pub subgraph: SubgraphId,
    pub block_hash: String,
    pub daa_score: i64,
    pub served_by: String,
}

/// Summary of one `unwind_committed_blocks_for_subgraph` call —
/// what was actually deleted and the audit row id that recorded it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedUnwindReport {
    /// Hashes that existed in `kasgraph_committed_block` and were
    /// deleted. May be shorter than the requested list if some
    /// hashes were never committed.
    pub removed_hashes: Vec<String>,
    /// `kasgraph_reorg_audit.id` of the row that records this
    /// unwind.
    pub audit_id: i64,
}

/// One detector hit persisted into `kasgraph_detected_pattern`.
/// Sourced from `kasgraph_detectors::DetectedPattern` plus the
/// committing block's `(subgraph, block_hash, block_daa_score)`
/// context.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedPatternRecord {
    pub subgraph: SubgraphId,
    pub block_hash: String,
    pub block_daa_score: i64,
    pub tx_hash: String,
    pub output_index: i32,
    /// Discriminant name (e.g. `"OpenSilverVault"`). Stored as text
    /// so adding a new variant in `kasgraph-detectors` doesn't need
    /// an enum migration on the SQL side.
    pub detector_kind: String,
    pub covenant_id: Option<String>,
    pub payload: serde_json::Value,
}

/// One version of a mapping-emitted entity, written into a
/// subgraph's per-schema `entity_versions` table. The mapping
/// runtime hands the node `EntityOp { entity, id, data }`s; the node
/// stamps each with the committing block's DAA score (the version
/// key) and persists it here. Versioning by DAA lets a reorg unwind
/// drop exactly the rows committed at or above the rolled-back
/// height, mirroring the POI/committed-block unwind.
#[derive(Debug, Clone, PartialEq)]
pub struct EntityVersionRecord {
    pub subgraph: SubgraphId,
    pub entity_type: String,
    pub entity_id: String,
    pub block_daa_score: i64,
    pub payload: serde_json::Value,
}

/// One row of a latest-state entity snapshot: the highest-DAA
/// version of each `(entity_type, entity_id)`. This is the read set
/// the mapping runtime's `store_get` is seeded from before a
/// dispatch.
#[derive(Debug, Clone, PartialEq)]
pub struct EntitySnapshotRow {
    pub entity_type: String,
    pub entity_id: String,
    pub payload: serde_json::Value,
}

/// A covenant UTXO the indexer locked, recorded so a later transaction
/// input that consumes `(tx_hash, output_index)` can be recognized as that
/// covenant's spend. Written on each `CovenantLocked` detector hit and
/// versioned by the locking block's DAA, so a reorg unwinds it alongside
/// the entity versions and POI committed at the same height.
#[derive(Debug, Clone, PartialEq)]
pub struct CovenantUtxoRecord {
    pub subgraph: SubgraphId,
    pub tx_hash: String,
    pub output_index: i32,
    pub block_daa_score: i64,
    /// Detector discriminant name (e.g. `"OpenSilverVault"`). Resolves the
    /// `CovenantSpent` handler when this UTXO is spent.
    pub detector_kind: String,
    pub covenant_id: Option<String>,
    /// The locked output's value in sompi. Protocol-observable at lock time,
    /// so a later spend can honestly report `spentValueSompi` without a
    /// spend-transaction decoder.
    pub value_sompi: i64,
    /// The locked covenant's detector payload — becomes the `state` half of
    /// the spend event's `{ spend, state }` payload.
    pub locked_state: serde_json::Value,
}

/// The covenant identified by a spend-input lookup: enough to resolve the
/// `CovenantSpent` handler (by `detector_kind`) and build the spend event
/// (the locked `state`, the covenant id, and the spent value).
#[derive(Debug, Clone, PartialEq)]
pub struct CovenantUtxoMatch {
    pub detector_kind: String,
    pub covenant_id: Option<String>,
    /// Value in sompi of the consumed output — the honest `spentValueSompi`.
    pub value_sompi: i64,
    pub locked_state: serde_json::Value,
}

/// A detected covenant spend: a block input consumed a tracked covenant
/// UTXO. Persisted so spends are durable before `CovenantSpent` mapping
/// dispatch exists, and versioned by the *spending* block's DAA so a reorg
/// of that block unwinds the spend while leaving the (earlier) lock-time
/// UTXO record intact. Every field is protocol-observable or
/// lineage-derived at detection time; `operation` is deliberately absent
/// until a spend-transaction decoder can derive covenant operation
/// semantics honestly.
#[derive(Debug, Clone, PartialEq)]
pub struct CovenantSpendRecord {
    pub subgraph: SubgraphId,
    pub spending_tx_hash: String,
    pub previous_tx_hash: String,
    pub previous_output_index: i32,
    pub block_daa_score: i64,
    pub detector_kind: String,
    pub covenant_id: Option<String>,
    pub spent_value_sompi: i64,
    /// The covenant id the lineage continues under, if the spending
    /// transaction produced a tracked covenant output carrying the same
    /// id (lineage transition); `None` when the lineage terminates. Since
    /// transitions inherit the predecessor's id, this equals `covenant_id`
    /// when present.
    pub successor_covenant_id: Option<String>,
}

/// Store handle with a live Postgres pool.
pub struct Store {
    pool: PgPool,
}

impl Store {
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(|err| StoreError::Connection(err.to_string()))?;

        Ok(Self { pool })
    }

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn migrate(&self) -> Result<(), StoreError> {
        MIGRATOR
            .run(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))
    }

    pub async fn ensure_subgraph_schema(&self, subgraph: &SubgraphId) -> Result<(), StoreError> {
        let schema = subgraph.schema_name();
        let create_schema_sql = format!("CREATE SCHEMA IF NOT EXISTS \"{}\"", schema);
        sqlx::query(&create_schema_sql)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        let create_entities_sql = format!(
            "CREATE TABLE IF NOT EXISTS \"{}\".entity_versions (\
                entity_type TEXT NOT NULL,\
                entity_id TEXT NOT NULL,\
                block_daa_score BIGINT NOT NULL,\
                payload JSONB NOT NULL,\
                PRIMARY KEY (entity_type, entity_id, block_daa_score)\
            )",
            schema
        );
        sqlx::query(&create_entities_sql)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        let create_covenant_utxos_sql = format!(
            "CREATE TABLE IF NOT EXISTS \"{}\".covenant_utxos (\
                tx_hash TEXT NOT NULL,\
                output_index INTEGER NOT NULL,\
                block_daa_score BIGINT NOT NULL,\
                detector_kind TEXT NOT NULL,\
                covenant_id TEXT,\
                value_sompi BIGINT NOT NULL,\
                locked_state JSONB NOT NULL,\
                PRIMARY KEY (tx_hash, output_index)\
            )",
            schema
        );
        sqlx::query(&create_covenant_utxos_sql)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        let create_covenant_spends_sql = format!(
            "CREATE TABLE IF NOT EXISTS \"{}\".covenant_spends (\
                spending_tx_hash TEXT NOT NULL,\
                previous_tx_hash TEXT NOT NULL,\
                previous_output_index INTEGER NOT NULL,\
                block_daa_score BIGINT NOT NULL,\
                detector_kind TEXT NOT NULL,\
                covenant_id TEXT,\
                spent_value_sompi BIGINT NOT NULL,\
                successor_covenant_id TEXT,\
                PRIMARY KEY (spending_tx_hash, previous_tx_hash, previous_output_index)\
            )",
            schema
        );
        sqlx::query(&create_covenant_spends_sql)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    pub async fn upsert_covenant_lineage_head(
        &self,
        head: &CovenantLineageHead,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_covenant_lineage_head \
             (covenant_id, subgraph, genesis_tx, current_utxo, last_seen_daa, lineage_count) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (covenant_id) DO UPDATE SET \
                 current_utxo = EXCLUDED.current_utxo, \
                 last_seen_daa = EXCLUDED.last_seen_daa, \
                 lineage_count = EXCLUDED.lineage_count",
        )
        .bind(&head.covenant_id)
        .bind(head.subgraph.schema_name())
        .bind(&head.genesis_tx)
        .bind(&head.current_utxo)
        .bind(head.last_seen_daa)
        .bind(head.lineage_count)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Fetch the current head for a covenant lineage, if one exists.
    /// Lineage is keyed globally by `covenant_id` (a deterministic
    /// hash of the genesis outpoint), so no subgraph filter is needed
    /// for the lookup; the stored `subgraph` scopes only reorg unwind.
    pub async fn fetch_covenant_lineage_head(
        &self,
        covenant_id: &str,
    ) -> Result<Option<CovenantLineageHead>, StoreError> {
        let row: Option<(String, String, String, String, i64, i32)> = sqlx::query_as(
            "SELECT covenant_id, subgraph, genesis_tx, current_utxo, last_seen_daa, lineage_count \
             FROM kasgraph_covenant_lineage_head WHERE covenant_id = $1",
        )
        .bind(covenant_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        row.map(
            |(covenant_id, subgraph, genesis_tx, current_utxo, last_seen_daa, lineage_count)| {
                Ok(CovenantLineageHead {
                    covenant_id,
                    subgraph: SubgraphId::new(subgraph)?,
                    genesis_tx,
                    current_utxo,
                    last_seen_daa,
                    lineage_count,
                })
            },
        )
        .transpose()
    }

    pub async fn insert_covenant_lineage_row(
        &self,
        row: &CovenantLineageRow,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_covenant_lineage_row \
             (covenant_id, subgraph, seq, tx_hash, output_index, state_bytes, daa_score) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&row.covenant_id)
        .bind(row.subgraph.schema_name())
        .bind(row.seq)
        .bind(&row.tx_hash)
        .bind(row.output_index)
        .bind(&row.state_bytes)
        .bind(row.daa_score)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    pub async fn insert_poi_checkpoint(
        &self,
        checkpoint: &PoiCheckpoint,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_poi \
             (subgraph, block_daa_score, poi_hash) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (subgraph, block_daa_score) DO UPDATE SET \
                 poi_hash = EXCLUDED.poi_hash",
        )
        .bind(checkpoint.subgraph.schema_name())
        .bind(checkpoint.block_daa_score)
        .bind(checkpoint.poi_hash.to_vec())
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    pub async fn insert_rpc_block_audit(
        &self,
        audit: &RpcBlockAuditRecord,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_rpc_block_audit \
             (block_hash, daa_score, served_by) \
             VALUES ($1, $2, $3)",
        )
        .bind(&audit.block_hash)
        .bind(audit.daa_score)
        .bind(&audit.served_by)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Record that `block_hash` was committed for `subgraph`. Calls
    /// to `unwind_committed_blocks_for_subgraph` use this table to
    /// find what to delete.
    pub async fn record_committed_block(
        &self,
        record: &CommittedBlockRecord,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_committed_block \
             (subgraph, block_hash, daa_score, served_by) \
             VALUES ($1, $2, $3, $4) \
             ON CONFLICT (subgraph, block_hash) DO UPDATE SET \
                 daa_score = EXCLUDED.daa_score, \
                 served_by = EXCLUDED.served_by",
        )
        .bind(record.subgraph.schema_name())
        .bind(&record.block_hash)
        .bind(record.daa_score)
        .bind(&record.served_by)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Highest-DAA surviving POI checkpoint for `subgraph`, or
    /// `None` if no POI has been written yet. Used to re-anchor
    /// `IngestionState.prior_poi` on startup and after an unwind so
    /// the next committed block continues the same hash chain.
    pub async fn latest_poi_for_subgraph(
        &self,
        subgraph: &SubgraphId,
    ) -> Result<Option<PoiCheckpoint>, StoreError> {
        let row: Option<(i64, Vec<u8>)> = sqlx::query_as(
            "SELECT block_daa_score, poi_hash FROM kasgraph_poi \
             WHERE subgraph = $1 \
             ORDER BY block_daa_score DESC \
             LIMIT 1",
        )
        .bind(subgraph.schema_name())
        .fetch_optional(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        let Some((block_daa_score, poi_bytes)) = row else {
            return Ok(None);
        };
        if poi_bytes.len() != 32 {
            return Err(StoreError::Query(format!(
                "latest POI for subgraph `{}` has unexpected length {} (want 32)",
                subgraph.schema_name(),
                poi_bytes.len()
            )));
        }
        let mut poi_hash = [0u8; 32];
        poi_hash.copy_from_slice(&poi_bytes);

        Ok(Some(PoiCheckpoint {
            subgraph: subgraph.clone(),
            block_daa_score,
            poi_hash,
        }))
    }

    /// Persist one detector hit. The PK is
    /// `(subgraph, block_hash, tx_hash, output_index, detector_kind)`
    /// so re-applying the same block (e.g. mid-recovery) is
    /// idempotent — duplicate inserts are silently overwritten via
    /// `ON CONFLICT DO UPDATE`.
    pub async fn insert_detected_pattern(
        &self,
        record: &DetectedPatternRecord,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_detected_pattern \
             (subgraph, block_hash, block_daa_score, tx_hash, output_index, \
              detector_kind, covenant_id, payload) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (subgraph, block_hash, tx_hash, output_index, detector_kind) \
             DO UPDATE SET \
                 block_daa_score = EXCLUDED.block_daa_score, \
                 covenant_id = EXCLUDED.covenant_id, \
                 payload = EXCLUDED.payload",
        )
        .bind(record.subgraph.schema_name())
        .bind(&record.block_hash)
        .bind(record.block_daa_score)
        .bind(&record.tx_hash)
        .bind(record.output_index)
        .bind(&record.detector_kind)
        .bind(record.covenant_id.as_ref())
        .bind(&record.payload)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Upsert one entity version into the subgraph's per-schema
    /// `entity_versions` table. Idempotent on `(entity_type,
    /// entity_id, block_daa_score)` so re-applying a block during
    /// recovery overwrites rather than duplicates.
    pub async fn upsert_entity_version(
        &self,
        record: &EntityVersionRecord,
    ) -> Result<(), StoreError> {
        sqlx::query(&upsert_entity_version_sql(record.subgraph.schema_name()))
            .bind(&record.entity_type)
            .bind(&record.entity_id)
            .bind(record.block_daa_score)
            .bind(&record.payload)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Latest committed state of a single entity, or `None` if it has
    /// never been written. "Latest" = highest `block_daa_score`.
    pub async fn latest_entity(
        &self,
        subgraph: &SubgraphId,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<Option<serde_json::Value>, StoreError> {
        let row: Option<(serde_json::Value,)> =
            sqlx::query_as(&latest_entity_sql(subgraph.schema_name()))
                .bind(entity_type)
                .bind(entity_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(row.map(|(payload,)| payload))
    }

    /// Latest-state snapshot of every entity in the subgraph: the
    /// highest-DAA version of each `(entity_type, entity_id)`. Seeds
    /// the mapping runtime's `store_get` read set.
    pub async fn snapshot_entities(
        &self,
        subgraph: &SubgraphId,
    ) -> Result<Vec<EntitySnapshotRow>, StoreError> {
        let rows: Vec<(String, String, serde_json::Value)> =
            sqlx::query_as(&snapshot_entities_sql(subgraph.schema_name()))
                .fetch_all(&self.pool)
                .await
                .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|(entity_type, entity_id, payload)| EntitySnapshotRow {
                entity_type,
                entity_id,
                payload,
            })
            .collect())
    }

    /// Delete every entity version committed at or above `from_daa`,
    /// part of a reorg unwind. Mirrors the POI/committed-block
    /// rollback so the same chain bytes reproduce the same entity
    /// state. Returns the number of rows removed.
    pub async fn unwind_entity_versions(
        &self,
        subgraph: &SubgraphId,
        from_daa: i64,
    ) -> Result<u64, StoreError> {
        let result = sqlx::query(&unwind_entity_versions_sql(subgraph.schema_name()))
            .bind(from_daa)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(result.rows_affected())
    }

    /// Record a covenant UTXO produced by a `CovenantLocked` hit so a later
    /// spend of `(tx_hash, output_index)` can be recognized. Idempotent on
    /// the outpoint, so re-applying a block during recovery overwrites
    /// rather than duplicates.
    pub async fn track_covenant_utxo(&self, record: &CovenantUtxoRecord) -> Result<(), StoreError> {
        sqlx::query(&track_covenant_utxo_sql(record.subgraph.schema_name()))
            .bind(&record.tx_hash)
            .bind(record.output_index)
            .bind(record.block_daa_score)
            .bind(&record.detector_kind)
            .bind(record.covenant_id.as_ref())
            .bind(record.value_sompi)
            .bind(&record.locked_state)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Look up the covenant a transaction input consumes, by its previous
    /// outpoint `(tx_hash, output_index)`. `Some` means the input spends a
    /// tracked covenant UTXO — the caller dispatches its `CovenantSpent`
    /// handler. `None` means the input consumes an ordinary (non-covenant)
    /// UTXO and is skipped.
    pub async fn lookup_covenant_utxo(
        &self,
        subgraph: &SubgraphId,
        tx_hash: &str,
        output_index: i32,
    ) -> Result<Option<CovenantUtxoMatch>, StoreError> {
        let row: Option<(String, Option<String>, i64, serde_json::Value)> =
            sqlx::query_as(&lookup_covenant_utxo_sql(subgraph.schema_name()))
                .bind(tx_hash)
                .bind(output_index)
                .fetch_optional(&self.pool)
                .await
                .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(row.map(
            |(detector_kind, covenant_id, value_sompi, locked_state)| CovenantUtxoMatch {
                detector_kind,
                covenant_id,
                value_sompi,
                locked_state,
            },
        ))
    }

    /// Drop every covenant UTXO locked at or above `from_daa`, part of a
    /// reorg unwind. Mirrors the entity-version/POI rollback so the same
    /// chain bytes reproduce the same tracker state. Returns rows removed.
    pub async fn unwind_covenant_utxos(
        &self,
        subgraph: &SubgraphId,
        from_daa: i64,
    ) -> Result<u64, StoreError> {
        let result = sqlx::query(&unwind_covenant_utxos_sql(subgraph.schema_name()))
            .bind(from_daa)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(result.rows_affected())
    }

    /// Record a detected covenant spend (a block input consumed a tracked
    /// covenant UTXO). Idempotent on the spending input, so re-applying the
    /// spend block during recovery overwrites rather than duplicates.
    pub async fn record_covenant_spend(
        &self,
        record: &CovenantSpendRecord,
    ) -> Result<(), StoreError> {
        sqlx::query(&record_covenant_spend_sql(record.subgraph.schema_name()))
            .bind(&record.spending_tx_hash)
            .bind(&record.previous_tx_hash)
            .bind(record.previous_output_index)
            .bind(record.block_daa_score)
            .bind(&record.detector_kind)
            .bind(record.covenant_id.as_ref())
            .bind(record.spent_value_sompi)
            .bind(record.successor_covenant_id.as_ref())
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    /// Whether the spending transaction `spending_tx_hash` produced a
    /// tracked covenant UTXO carrying `covenant_id` — i.e. the lineage
    /// continues through this spend. Used to resolve a spend's
    /// `successorCovenantId`. The continuation output is tracked before
    /// spend detection runs (the lock loop precedes the spend loop within
    /// a block, and a spend and its successor share a transaction).
    pub async fn covenant_lineage_continues(
        &self,
        subgraph: &SubgraphId,
        spending_tx_hash: &str,
        covenant_id: &str,
    ) -> Result<bool, StoreError> {
        let row: Option<(bool,)> =
            sqlx::query_as(&covenant_lineage_continues_sql(subgraph.schema_name()))
                .bind(spending_tx_hash)
                .bind(covenant_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(row.map(|(exists,)| exists).unwrap_or(false))
    }

    /// Drop every covenant spend recorded at or above `from_daa`, part of a
    /// reorg unwind. Keyed on the *spending* block's DAA, so a reorg that
    /// drops the spend rolls the spend record back while the (earlier)
    /// lock-time UTXO record survives — restoring spend-detectability if the
    /// outpoint is consumed again on the surviving chain. Returns rows
    /// removed.
    pub async fn unwind_covenant_spends(
        &self,
        subgraph: &SubgraphId,
        from_daa: i64,
    ) -> Result<u64, StoreError> {
        let result = sqlx::query(&unwind_covenant_spends_sql(subgraph.schema_name()))
            .bind(from_daa)
            .execute(&self.pool)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(result.rows_affected())
    }

    /// Roll back KIP-20 lineage state for `subgraph` at or above
    /// `from_daa`, part of a reorg unwind. Runs atomically: (1) delete
    /// the lineage rows this subgraph recorded at or above the cutoff;
    /// (2) drop heads that no longer have any surviving row; (3) re-point
    /// each surviving head at its highest-`seq` surviving row, restoring
    /// `current_utxo`/`last_seen_daa`/`lineage_count` to the pre-reorg
    /// chain. Returns the number of lineage rows removed.
    pub async fn unwind_covenant_lineage(
        &self,
        subgraph: &SubgraphId,
        from_daa: i64,
    ) -> Result<u64, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        let removed = sqlx::query(
            "DELETE FROM kasgraph_covenant_lineage_row \
             WHERE subgraph = $1 AND daa_score >= $2",
        )
        .bind(subgraph.schema_name())
        .bind(from_daa)
        .execute(&mut *tx)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?
        .rows_affected();

        sqlx::query(
            "DELETE FROM kasgraph_covenant_lineage_head h \
             WHERE h.subgraph = $1 \
               AND NOT EXISTS ( \
                   SELECT 1 FROM kasgraph_covenant_lineage_row r \
                   WHERE r.covenant_id = h.covenant_id)",
        )
        .bind(subgraph.schema_name())
        .execute(&mut *tx)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        sqlx::query(
            "UPDATE kasgraph_covenant_lineage_head h SET \
                 current_utxo = r.tx_hash || ':' || r.output_index, \
                 last_seen_daa = r.daa_score, \
                 lineage_count = r.seq + 1 \
             FROM ( \
                 SELECT DISTINCT ON (covenant_id) \
                     covenant_id, seq, tx_hash, output_index, daa_score \
                 FROM kasgraph_covenant_lineage_row \
                 WHERE subgraph = $1 \
                 ORDER BY covenant_id, seq DESC \
             ) r \
             WHERE h.covenant_id = r.covenant_id AND h.subgraph = $1",
        )
        .bind(subgraph.schema_name())
        .execute(&mut *tx)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        tx.commit()
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(removed)
    }

    /// Roll back committed state for the listed block hashes, in a
    /// single SQL transaction. The order inside the transaction
    /// matches the BlockDAG reorg semantics doc:
    ///   1. Resolve which of the listed hashes are actually
    ///      committed for this subgraph (skip any that aren't).
    ///   2. Sort by `daa_score DESC` so deletion proceeds from the
    ///      newest block backwards.
    ///   3. Delete matching `kasgraph_poi` rows, then matching
    ///      `kasgraph_rpc_block_audit` rows, then the
    ///      `kasgraph_committed_block` rows themselves.
    ///   4. Insert a `kasgraph_reorg_audit` row recording the
    ///      hashes removed, the highest deleted DAA, the reason
    ///      string, and the wall-clock start/finish times.
    ///
    /// Returns a [`CommittedUnwindReport`] describing what actually
    /// changed.
    pub async fn unwind_committed_blocks_for_subgraph(
        &self,
        subgraph: &SubgraphId,
        block_hashes: &[String],
        reason: &str,
    ) -> Result<CommittedUnwindReport, StoreError> {
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        let rows: Vec<(String, i64)> = sqlx::query_as(
            "SELECT block_hash, daa_score FROM kasgraph_committed_block \
             WHERE subgraph = $1 AND block_hash = ANY($2) \
             ORDER BY daa_score DESC",
        )
        .bind(subgraph.schema_name())
        .bind(block_hashes)
        .fetch_all(&mut *tx)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        let removed_hashes: Vec<String> = rows.iter().map(|(h, _)| h.clone()).collect();
        let removed_daa_scores: Vec<i64> = rows.iter().map(|(_, d)| *d).collect();
        let at_daa = removed_daa_scores.iter().copied().max().unwrap_or(0);

        if !removed_hashes.is_empty() {
            sqlx::query(
                "DELETE FROM kasgraph_poi \
                 WHERE subgraph = $1 AND block_daa_score = ANY($2)",
            )
            .bind(subgraph.schema_name())
            .bind(&removed_daa_scores)
            .execute(&mut *tx)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

            sqlx::query(
                "DELETE FROM kasgraph_rpc_block_audit \
                 WHERE block_hash = ANY($1)",
            )
            .bind(&removed_hashes)
            .execute(&mut *tx)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

            sqlx::query(
                "DELETE FROM kasgraph_committed_block \
                 WHERE subgraph = $1 AND block_hash = ANY($2)",
            )
            .bind(subgraph.schema_name())
            .bind(&removed_hashes)
            .execute(&mut *tx)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

            // Detector hits anchored on the unwound blocks are
            // dropped in the same transaction, so a replay of the
            // surviving chain reproduces the same detector ledger.
            sqlx::query(
                "DELETE FROM kasgraph_detected_pattern \
                 WHERE subgraph = $1 AND block_hash = ANY($2)",
            )
            .bind(subgraph.schema_name())
            .bind(&removed_hashes)
            .execute(&mut *tx)
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;
        }

        let audit_id: (i64,) = sqlx::query_as(
            "INSERT INTO kasgraph_reorg_audit \
             (subgraph, at_daa, removed_hashes, removed_count, reason, unwind_finished_at) \
             VALUES ($1, $2, $3, $4, $5, NOW()) \
             RETURNING id",
        )
        .bind(subgraph.schema_name())
        .bind(at_daa)
        .bind(&removed_hashes)
        .bind(removed_hashes.len() as i32)
        .bind(reason)
        .fetch_one(&mut *tx)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        tx.commit()
            .await
            .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(CommittedUnwindReport {
            removed_hashes,
            audit_id: audit_id.0,
        })
    }
}

// ---- entity_versions SQL builders --------------------------------------
//
// The schema name is a validated `SubgraphId` (lowercase / digits /
// underscore only — see `SubgraphId::new`), so interpolating it into the
// table-qualified name is injection-safe, matching `ensure_subgraph_schema`.
// Kept as pure functions so the SQL shape is unit-testable without a DB.

fn upsert_entity_version_sql(schema: &str) -> String {
    format!(
        "INSERT INTO \"{schema}\".entity_versions \
         (entity_type, entity_id, block_daa_score, payload) \
         VALUES ($1, $2, $3, $4) \
         ON CONFLICT (entity_type, entity_id, block_daa_score) \
         DO UPDATE SET payload = EXCLUDED.payload"
    )
}

fn latest_entity_sql(schema: &str) -> String {
    format!(
        "SELECT payload FROM \"{schema}\".entity_versions \
         WHERE entity_type = $1 AND entity_id = $2 \
         ORDER BY block_daa_score DESC LIMIT 1"
    )
}

fn snapshot_entities_sql(schema: &str) -> String {
    format!(
        "SELECT DISTINCT ON (entity_type, entity_id) entity_type, entity_id, payload \
         FROM \"{schema}\".entity_versions \
         ORDER BY entity_type, entity_id, block_daa_score DESC"
    )
}

fn unwind_entity_versions_sql(schema: &str) -> String {
    format!("DELETE FROM \"{schema}\".entity_versions WHERE block_daa_score >= $1")
}

// ---- covenant_utxos SQL builders ---------------------------------------
//
// Same injection-safety argument as the entity_versions builders: `schema`
// is a validated `SubgraphId`. Pure functions so the SQL is unit-testable.

fn track_covenant_utxo_sql(schema: &str) -> String {
    format!(
        "INSERT INTO \"{schema}\".covenant_utxos \
         (tx_hash, output_index, block_daa_score, detector_kind, covenant_id, value_sompi, locked_state) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) \
         ON CONFLICT (tx_hash, output_index) \
         DO UPDATE SET \
             block_daa_score = EXCLUDED.block_daa_score, \
             detector_kind = EXCLUDED.detector_kind, \
             covenant_id = EXCLUDED.covenant_id, \
             value_sompi = EXCLUDED.value_sompi, \
             locked_state = EXCLUDED.locked_state"
    )
}

fn lookup_covenant_utxo_sql(schema: &str) -> String {
    format!(
        "SELECT detector_kind, covenant_id, value_sompi, locked_state \
         FROM \"{schema}\".covenant_utxos \
         WHERE tx_hash = $1 AND output_index = $2"
    )
}

fn unwind_covenant_utxos_sql(schema: &str) -> String {
    format!("DELETE FROM \"{schema}\".covenant_utxos WHERE block_daa_score >= $1")
}

fn record_covenant_spend_sql(schema: &str) -> String {
    format!(
        "INSERT INTO \"{schema}\".covenant_spends \
         (spending_tx_hash, previous_tx_hash, previous_output_index, block_daa_score, detector_kind, covenant_id, spent_value_sompi, successor_covenant_id) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
         ON CONFLICT (spending_tx_hash, previous_tx_hash, previous_output_index) \
         DO UPDATE SET \
             block_daa_score = EXCLUDED.block_daa_score, \
             detector_kind = EXCLUDED.detector_kind, \
             covenant_id = EXCLUDED.covenant_id, \
             spent_value_sompi = EXCLUDED.spent_value_sompi, \
             successor_covenant_id = EXCLUDED.successor_covenant_id"
    )
}

fn covenant_lineage_continues_sql(schema: &str) -> String {
    format!(
        "SELECT EXISTS(\
             SELECT 1 FROM \"{schema}\".covenant_utxos \
             WHERE tx_hash = $1 AND covenant_id = $2\
         )"
    )
}

fn unwind_covenant_spends_sql(schema: &str) -> String {
    format!("DELETE FROM \"{schema}\".covenant_spends WHERE block_daa_score >= $1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subgraph_id_accepts_safe_schema_names() {
        let subgraph = SubgraphId::new("kasbonds_mainnet_v1").unwrap();
        assert_eq!(subgraph.schema_name(), "kasbonds_mainnet_v1");
    }

    #[test]
    fn subgraph_id_rejects_unsafe_schema_names() {
        assert!(matches!(
            SubgraphId::new("KasBonds"),
            Err(StoreError::InvalidSubgraphId(_))
        ));
        assert!(matches!(
            SubgraphId::new("kasbonds-prod"),
            Err(StoreError::InvalidSubgraphId(_))
        ));
        assert!(matches!(
            SubgraphId::new(""),
            Err(StoreError::InvalidSubgraphId(_))
        ));
    }

    #[test]
    fn upsert_entity_version_sql_targets_the_subgraph_schema_and_is_idempotent() {
        let sql = upsert_entity_version_sql("kasbonds_mainnet_v1");
        assert!(sql.contains("\"kasbonds_mainnet_v1\".entity_versions"));
        assert!(sql.contains("ON CONFLICT (entity_type, entity_id, block_daa_score)"));
        assert!(sql.contains("DO UPDATE SET payload = EXCLUDED.payload"));
    }

    #[test]
    fn latest_entity_sql_reads_the_highest_daa_version() {
        let sql = latest_entity_sql("krc20");
        assert!(sql.contains("\"krc20\".entity_versions"));
        assert!(sql.contains("WHERE entity_type = $1 AND entity_id = $2"));
        assert!(sql.contains("ORDER BY block_daa_score DESC LIMIT 1"));
    }

    #[test]
    fn snapshot_entities_sql_takes_one_row_per_entity_key() {
        let sql = snapshot_entities_sql("krc721");
        assert!(sql.contains("DISTINCT ON (entity_type, entity_id)"));
        assert!(sql.contains("\"krc721\".entity_versions"));
        // DISTINCT ON requires the leading ORDER BY keys to match, with
        // block_daa_score DESC last so the surviving row is the latest.
        assert!(sql.contains("ORDER BY entity_type, entity_id, block_daa_score DESC"));
    }

    #[test]
    fn unwind_entity_versions_sql_deletes_at_or_above_the_cutoff() {
        let sql = unwind_entity_versions_sql("network_stats");
        assert!(sql.contains("DELETE FROM \"network_stats\".entity_versions"));
        assert!(sql.contains("WHERE block_daa_score >= $1"));
    }

    #[test]
    fn track_covenant_utxo_sql_targets_the_schema_and_is_idempotent_on_outpoint() {
        let sql = track_covenant_utxo_sql("kasbonds");
        assert!(sql.contains("\"kasbonds\".covenant_utxos"));
        assert!(sql.contains(
            "(tx_hash, output_index, block_daa_score, detector_kind, covenant_id, value_sompi, locked_state)"
        ));
        assert!(sql.contains("ON CONFLICT (tx_hash, output_index)"));
        assert!(sql.contains("value_sompi = EXCLUDED.value_sompi"));
        assert!(sql.contains("locked_state = EXCLUDED.locked_state"));
    }

    #[test]
    fn lookup_covenant_utxo_sql_reads_by_outpoint() {
        let sql = lookup_covenant_utxo_sql("krc20");
        assert!(sql.contains("SELECT detector_kind, covenant_id, value_sompi, locked_state"));
        assert!(sql.contains("\"krc20\".covenant_utxos"));
        assert!(sql.contains("WHERE tx_hash = $1 AND output_index = $2"));
    }

    #[test]
    fn unwind_covenant_utxos_sql_deletes_at_or_above_the_cutoff() {
        let sql = unwind_covenant_utxos_sql("network_stats");
        assert!(sql.contains("DELETE FROM \"network_stats\".covenant_utxos"));
        assert!(sql.contains("WHERE block_daa_score >= $1"));
    }

    #[test]
    fn record_covenant_spend_sql_targets_the_schema_and_is_idempotent_on_input() {
        let sql = record_covenant_spend_sql("kasbonds");
        assert!(sql.contains("\"kasbonds\".covenant_spends"));
        assert!(sql.contains(
            "(spending_tx_hash, previous_tx_hash, previous_output_index, block_daa_score, detector_kind, covenant_id, spent_value_sompi, successor_covenant_id)"
        ));
        assert!(
            sql.contains("ON CONFLICT (spending_tx_hash, previous_tx_hash, previous_output_index)")
        );
        assert!(sql.contains("spent_value_sompi = EXCLUDED.spent_value_sompi"));
        assert!(sql.contains("successor_covenant_id = EXCLUDED.successor_covenant_id"));
    }

    #[test]
    fn covenant_lineage_continues_sql_checks_for_a_same_id_output_of_the_tx() {
        let sql = covenant_lineage_continues_sql("kasbonds");
        assert!(sql.contains("SELECT EXISTS("));
        assert!(sql.contains("\"kasbonds\".covenant_utxos"));
        assert!(sql.contains("WHERE tx_hash = $1 AND covenant_id = $2"));
    }

    #[test]
    fn unwind_covenant_spends_sql_deletes_at_or_above_the_cutoff() {
        let sql = unwind_covenant_spends_sql("network_stats");
        assert!(sql.contains("DELETE FROM \"network_stats\".covenant_spends"));
        assert!(sql.contains("WHERE block_daa_score >= $1"));
    }

    #[test]
    fn migrator_embeds_all_schema_slices_in_order() {
        let migrations = MIGRATOR.iter().collect::<Vec<_>>();
        assert_eq!(migrations.len(), 4);
        assert_eq!(migrations[0].version, 20260526110500);
        assert_eq!(migrations[1].version, 20260526150000);
        assert_eq!(migrations[2].version, 20260526160000);
        assert_eq!(migrations[3].version, 20260528120000);
    }
}
