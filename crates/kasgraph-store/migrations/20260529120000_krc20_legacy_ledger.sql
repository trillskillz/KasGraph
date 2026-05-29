-- Legacy (Kasplex-era) KRC-20 ledger: the durable journal of accepted
-- inscription operations behind the pure `Krc20Ledger` state machine in
-- kasgraph-detectors. Legacy KRC-20 state is purely a function of the
-- accepted operation stream, so the ledger is reconstructed by replaying
-- these rows in acceptance order; a reorg deletes the rows at or above the
-- reorged DAA and the surviving stream is re-replayed
-- (docs/references/KRC20_KRC721_REFERENCE.md:54).
--
-- Keyed globally by (tick, accepting_block_hash, seq) — a tick is global
-- across the Kasplex view, matching the lineage tables' global keying. The
-- `subgraph` column scopes only reorg unwind. `tx_hash` is UNIQUE: exactly
-- one inscription rides a transaction payload, so it is the replay-safety
-- idempotency key.
--
-- Amounts are stored as the raw decimal strings the inscription carried,
-- not BIGINT: KRC-20 amounts are u64 and can exceed i64::MAX, so a BIGINT
-- column would silently corrupt large values. Replay re-parses them through
-- the same strict decimal-u64 path the envelope parser uses.
CREATE TABLE IF NOT EXISTS kasgraph_krc20_legacy_ledger (
    tick TEXT NOT NULL,
    accepting_block_hash TEXT NOT NULL,
    seq BIGINT NOT NULL CHECK (seq >= 0),
    subgraph TEXT NOT NULL,
    accepting_daa_score BIGINT NOT NULL,
    tx_hash TEXT NOT NULL,
    op TEXT NOT NULL,
    tick_raw TEXT NOT NULL,
    sender TEXT NOT NULL,
    recipient TEXT,
    amount TEXT,
    max_supply TEXT,
    mint_limit TEXT,
    PRIMARY KEY (tick, accepting_block_hash, seq),
    UNIQUE (tx_hash)
);

-- Scopes reorg unwind to a subgraph and the reorged DAA range.
CREATE INDEX IF NOT EXISTS kasgraph_krc20_legacy_ledger_subgraph_daa_idx
    ON kasgraph_krc20_legacy_ledger (subgraph, accepting_daa_score DESC);

-- Acceptance-order scan for ledger replay.
CREATE INDEX IF NOT EXISTS kasgraph_krc20_legacy_ledger_replay_idx
    ON kasgraph_krc20_legacy_ledger (tick, accepting_daa_score, seq);
