-- Phase 2.3 follow-through: committed-state unwind support.
--
-- Until now, kasgraph_poi + kasgraph_rpc_block_audit recorded each
-- committed block but nothing tied a (subgraph, block_hash) pair to
-- a deletable row. When a virtualChainChanged event removes a
-- chain block hash whose state was already committed, the indexer
-- needs to (a) know which subgraph wrote it, (b) delete the POI +
-- audit rows in order, and (c) record that the unwind happened.
--
-- This migration adds the two tables that make that possible.
-- See docs/references/BLOCKDAG_REORG_SEMANTICS.md for the full
-- ordered-unwind procedure.

CREATE TABLE IF NOT EXISTS kasgraph_committed_block (
    subgraph TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    daa_score BIGINT NOT NULL,
    served_by TEXT NOT NULL,
    committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subgraph, block_hash)
);

CREATE INDEX IF NOT EXISTS kasgraph_committed_block_subgraph_daa_idx
    ON kasgraph_committed_block (subgraph, daa_score DESC);

CREATE INDEX IF NOT EXISTS kasgraph_committed_block_hash_idx
    ON kasgraph_committed_block (block_hash);

CREATE TABLE IF NOT EXISTS kasgraph_reorg_audit (
    id BIGSERIAL PRIMARY KEY,
    subgraph TEXT NOT NULL,
    at_daa BIGINT NOT NULL,
    removed_hashes TEXT[] NOT NULL,
    removed_count INTEGER NOT NULL,
    reason TEXT NOT NULL,
    unwind_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    unwind_finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS kasgraph_reorg_audit_subgraph_daa_idx
    ON kasgraph_reorg_audit (subgraph, at_daa DESC);
