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

use sqlx::{PgPool, postgres::PgPoolOptions};
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

    #[error("POI mismatch for subgraph `{subgraph}` at block {block}: expected {expected}, got {got}")]
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
    pub genesis_tx: String,
    pub current_utxo: String,
    pub last_seen_daa: i64,
    pub lineage_count: i32,
}

/// Append-only per-transition lineage row for a covenant id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CovenantLineageRow {
    pub covenant_id: String,
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

        Ok(())
    }

    pub async fn upsert_covenant_lineage_head(
        &self,
        head: &CovenantLineageHead,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_covenant_lineage_head \
             (covenant_id, genesis_tx, current_utxo, last_seen_daa, lineage_count) \
             VALUES ($1, $2, $3, $4, $5) \
             ON CONFLICT (covenant_id) DO UPDATE SET \
                 current_utxo = EXCLUDED.current_utxo, \
                 last_seen_daa = EXCLUDED.last_seen_daa, \
                 lineage_count = EXCLUDED.lineage_count",
        )
        .bind(&head.covenant_id)
        .bind(&head.genesis_tx)
        .bind(&head.current_utxo)
        .bind(head.last_seen_daa)
        .bind(head.lineage_count)
        .execute(&self.pool)
        .await
        .map_err(|err| StoreError::Query(err.to_string()))?;

        Ok(())
    }

    pub async fn insert_covenant_lineage_row(
        &self,
        row: &CovenantLineageRow,
    ) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO kasgraph_covenant_lineage_row \
             (covenant_id, seq, tx_hash, output_index, state_bytes, daa_score) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&row.covenant_id)
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

    pub async fn insert_poi_checkpoint(&self, checkpoint: &PoiCheckpoint) -> Result<(), StoreError> {
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
    fn migrator_embeds_first_schema_slice() {
        let migrations = MIGRATOR.iter().collect::<Vec<_>>();
        assert_eq!(migrations.len(), 1);
        assert_eq!(migrations[0].version, 20260526110500);
    }
}
