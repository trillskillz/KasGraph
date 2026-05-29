-- Legacy (Kasplex-era) KRC-721 ledger: the durable journal of accepted
-- NFT inscription operations behind the pure `Krc721Ledger` state machine
-- in kasgraph-detectors. Like legacy KRC-20, legacy KRC-721 state is purely
-- a function of the accepted operation stream, so per-token ownership is
-- reconstructed by replaying these rows in acceptance order; a reorg deletes
-- the rows at or above the reorged DAA and the surviving stream is
-- re-replayed (docs/references/KRC20_KRC721_REFERENCE.md:58-74).
--
-- This is the direct parallel of `kasgraph_krc20_legacy_ledger`: one journal
-- table records every op (deploy/mint/transfer/burn). The `_token` (current
-- owner) / `_transfer` (history) head tables the reference names are a
-- query-layer projection over this journal and land with the GraphQL/MCP
-- consumer, not the indexing path.
--
-- Keyed globally by (tick, accepting_block_hash, seq) — a collection tick is
-- global across the Kasplex view, matching the lineage / legacy-KRC-20
-- tables' global keying. The `subgraph` column scopes only reorg unwind.
-- `tx_hash` is UNIQUE: exactly one inscription rides a transaction payload,
-- so it is the replay-safety idempotency key.
--
-- `token_id` and `max_supply` are stored as the raw decimal strings the
-- inscription carried, not BIGINT: KRC-721 ids and collection sizes are u64
-- and can exceed i64::MAX, so a BIGINT column would silently corrupt large
-- values. Replay re-parses them through the same strict decimal-u64 path the
-- envelope parser uses (the same rationale as legacy-KRC-20 amounts).
CREATE TABLE IF NOT EXISTS kasgraph_krc721_legacy_ledger (
    tick TEXT NOT NULL,
    accepting_block_hash TEXT NOT NULL,
    seq BIGINT NOT NULL CHECK (seq >= 0),
    subgraph TEXT NOT NULL,
    accepting_daa_score BIGINT NOT NULL,
    tx_hash TEXT NOT NULL,
    op TEXT NOT NULL,
    tick_raw TEXT NOT NULL,
    sender TEXT NOT NULL,
    token_id TEXT,
    recipient TEXT,
    metadata_uri TEXT,
    max_supply TEXT,
    PRIMARY KEY (tick, accepting_block_hash, seq),
    UNIQUE (tx_hash)
);

-- Scopes reorg unwind to a subgraph and the reorged DAA range.
CREATE INDEX IF NOT EXISTS kasgraph_krc721_legacy_ledger_subgraph_daa_idx
    ON kasgraph_krc721_legacy_ledger (subgraph, accepting_daa_score DESC);

-- Acceptance-order scan for ledger replay.
CREATE INDEX IF NOT EXISTS kasgraph_krc721_legacy_ledger_replay_idx
    ON kasgraph_krc721_legacy_ledger (tick, accepting_daa_score, seq);
