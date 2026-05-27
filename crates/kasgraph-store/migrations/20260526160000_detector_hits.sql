-- Phase 2.5 + 2.8 follow-through: persisted detector hits.
--
-- kasgraph-detectors runs against every output of every committed
-- block. Until now the hits were only logged. This migration adds
-- the table that holds them, plus indexes that make the obvious
-- two queries — "what patterns appeared in this subgraph recently?"
-- and "where did pattern X show up?" — cheap.
--
-- See docs/references/BLOCKDAG_REORG_SEMANTICS.md for how this
-- table participates in the unwind procedure: every detector row
-- is deleted alongside POI / audit / committed-block rows when a
-- block is rolled back, so the same chain bytes always produce
-- the same detector ledger.

CREATE TABLE IF NOT EXISTS kasgraph_detected_pattern (
    subgraph TEXT NOT NULL,
    block_hash TEXT NOT NULL,
    block_daa_score BIGINT NOT NULL,
    tx_hash TEXT NOT NULL,
    output_index INTEGER NOT NULL,
    detector_kind TEXT NOT NULL,
    covenant_id TEXT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (subgraph, block_hash, tx_hash, output_index, detector_kind)
);

CREATE INDEX IF NOT EXISTS kasgraph_detected_pattern_subgraph_daa_idx
    ON kasgraph_detected_pattern (subgraph, block_daa_score DESC);

CREATE INDEX IF NOT EXISTS kasgraph_detected_pattern_kind_idx
    ON kasgraph_detected_pattern (subgraph, detector_kind, block_daa_score DESC);

CREATE INDEX IF NOT EXISTS kasgraph_detected_pattern_covenant_idx
    ON kasgraph_detected_pattern (subgraph, covenant_id)
    WHERE covenant_id IS NOT NULL;
