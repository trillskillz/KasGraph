CREATE TABLE IF NOT EXISTS kasgraph_covenant_lineage_head (
    covenant_id TEXT PRIMARY KEY,
    subgraph TEXT NOT NULL,
    genesis_tx TEXT NOT NULL,
    current_utxo TEXT NOT NULL,
    last_seen_daa BIGINT NOT NULL,
    lineage_count INTEGER NOT NULL CHECK (lineage_count >= 0)
);

CREATE TABLE IF NOT EXISTS kasgraph_covenant_lineage_row (
    covenant_id TEXT NOT NULL REFERENCES kasgraph_covenant_lineage_head(covenant_id) ON DELETE CASCADE,
    subgraph TEXT NOT NULL,
    seq INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    output_index INTEGER NOT NULL,
    state_bytes BYTEA NOT NULL,
    daa_score BIGINT NOT NULL,
    PRIMARY KEY (covenant_id, seq),
    -- A covenant output is exactly one lineage step; this is the
    -- replay-safety idempotency key (also indexes the existence lookup).
    UNIQUE (covenant_id, tx_hash, output_index)
);

CREATE INDEX IF NOT EXISTS kasgraph_covenant_lineage_row_subgraph_daa_idx
    ON kasgraph_covenant_lineage_row (subgraph, daa_score DESC);

CREATE INDEX IF NOT EXISTS kasgraph_covenant_lineage_row_daa_idx
    ON kasgraph_covenant_lineage_row (daa_score DESC);

CREATE TABLE IF NOT EXISTS kasgraph_poi (
    subgraph TEXT NOT NULL,
    block_daa_score BIGINT NOT NULL,
    poi_hash BYTEA NOT NULL,
    PRIMARY KEY (subgraph, block_daa_score)
);

CREATE INDEX IF NOT EXISTS kasgraph_poi_subgraph_daa_idx
    ON kasgraph_poi (subgraph, block_daa_score DESC);

CREATE TABLE IF NOT EXISTS kasgraph_rpc_block_audit (
    id BIGSERIAL PRIMARY KEY,
    block_hash TEXT NOT NULL,
    daa_score BIGINT NOT NULL,
    served_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kasgraph_rpc_block_audit_block_hash_idx
    ON kasgraph_rpc_block_audit (block_hash);

CREATE INDEX IF NOT EXISTS kasgraph_rpc_block_audit_daa_idx
    ON kasgraph_rpc_block_audit (daa_score DESC);
