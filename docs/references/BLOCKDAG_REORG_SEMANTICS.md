# BlockDAG reorg semantics

How KasGraph handles BlockDAG-specific reorgs without losing correctness or breaking POI continuity. This document is the guardrail for the Phase 2.3 ingestion loop and the Phase 2.4 store unwind procedure.

## Why BlockDAG reorgs are not single-chain reorgs

On a single-chain protocol (Bitcoin, Ethereum), a reorg replaces a suffix of the canonical chain. The indexer model is straightforward: unwind blocks above the fork point in reverse order, then replay the new tip blocks in order.

Kaspa runs the **GHOSTDAG** protocol on a BlockDAG. Two things change:

1. **Many blocks at a single DAA score.** A DAA score is not a unique chain-height identifier; multiple blocks may share one. The unit of canonical ordering is the **virtual selected parent chain (VSPC)**, computed by GHOSTDAG over the DAG.
2. **Non-VSPC blocks still carry transactions.** A block that is not currently part of the VSPC may still be referenced via merge-set blue/red sets. Those transactions enter the ledger only when one of the merging selected-chain blocks accepts them. Reorgs therefore reshuffle *transaction acceptance*, not just block-level chain membership.

The practical consequence: a reorg surface from the RPC layer is `virtualChainChanged { addedChainBlockHashes, removedChainBlockHashes, acceptedTransactionIds }` rather than "new tip, old tip is dead." The indexer must roll back acceptance for `removedChainBlockHashes` and apply acceptance for `addedChainBlockHashes` in the order delivered.

## KIP-20 finality threshold

KIP-20 anchors covenant state to consensus. For covenant correctness, KasGraph distinguishes three states for any block:

| State | Definition | Persistence shape |
| --- | --- | --- |
| `Probabilistic` | Seen by RPC, on the current VSPC, but below the finality depth. Subject to reorg. | Buffered in memory; written to Postgres only as a tagged transient view. |
| `Committed` | At or above finality depth on the current VSPC. | Written as authoritative row; POI checkpoint produced. |
| `Pruned` | Below the consensus pruning point. Historical, no longer fetchable from a default node. | Not re-ingested; relied on as POI ancestry. |

The finality threshold is configurable per network. For mainnet we treat the consensus `finalityDepth` (~86,400 selected-parent blocks ≈ 24h at 1 bps; subject to ramp under Toccata) as the boundary. Operators can override via `KASGRAPH_FINALITY_DEPTH` when running on testnets or for deterministic replay tests. The current scaffold uses an `is_finalized` flag carried inline on each `BootstrapBlock`; the runtime promotion path lives in `kasgraph-node::IngestionState::ingest`.

## How reorgs surface from the RPC layer

KasGraph subscribes to the wRPC notification stream and normalises into `ChainNotification` (see `crates/kasgraph-rpc/src/lib.rs`). The relevant variants for reorg handling:

- `BlockAdded { hash, daa_score, is_finalized }` — a new block exists in the DAG. Whether it is selected-chain-accepted is decided by a later `VirtualChainChanged`.
- `VirtualChainChanged { added_chain_block_hashes, removed_chain_block_hashes, accepted_transaction_ids }` — the canonical VSPC shifted. Any hash in `removed_chain_block_hashes` previously contributed accepted transactions that must be unwound.
- `RecoveryRequired { from_daa_score, to_daa_score, reason }` — a gap was detected (subscription stall, missed event, manual replay request). The ingest loop must re-fetch this range before resuming live tailing.

`virtualChainChanged` is **always the authority** on VSPC membership. `BlockAdded` alone is not enough to commit anything; it can only mark a block as known. This split is intentional: it mirrors the upstream rusty-kaspa consensus event model and keeps the indexer's notion of "accepted" aligned with the node's.

## Postgres unwind procedure

When a `removedChainBlockHashes` list arrives:

1. **Probabilistic rollback (in-memory, no SQL).** `IngestionState::remove_probabilistic_by_hashes` drops any buffered probabilistic blocks that match. This is cheap and reorg-safe because nothing is on disk yet for those blocks.
2. **Committed rollback (SQL, ordered).** For every removed hash whose state was previously committed, in reverse DAA-score order:
   - Delete `kasgraph_covenant_lineage_row` rows whose `(tx_hash, output_idx)` were produced by transactions accepted by this block. Use a join against the per-block acceptance index.
   - For each affected `covenant_id`, recompute `kasgraph_covenant_lineage_head.current_utxo`, `lineage_count`, `last_seen_daa` from the surviving max-`seq` row, or delete the head row if no rows remain.
   - Delete `kasgraph_poi` checkpoints anchored at this block hash.
   - Delete `kasgraph_rpc_block_audit` rows for this block (so a re-fetch creates a fresh audit, not a duplicate).
3. **Apply additions.** For every hash in `addedChainBlockHashes`, fetch the block via `kasgraph-rpc::fetch_blocks` (which preserves ordering), feed it through `IngestionState::ingest`, and write the resulting committed rows + new POI checkpoint.
4. **Anchor a unwind marker.** Insert a `kasgraph_reorg_audit` row recording `(at_daa, removed_hashes[], added_hashes[], unwind_started_at, unwind_finished_at)` so later POI reproductions can confirm the rollback path matches.

Step 2 is the slice that the current scaffold deliberately defers: today only probabilistic rollback is wired; committed rollback logs and ignores conflicting removes. The schema migration for committed unwind lands alongside the next slice.

### Ordering rules inside a single unwind

- Roll back **inside a single covenant lineage** in reverse `seq` order. Never delete `seq=K` while `seq=K+1` still exists; the foreign key would catch it but the error is noisy.
- Roll back **across covenants** in reverse `(daa_score, accepting_block_hash)` lexicographic order. This matches the order in which acceptance was applied and keeps the unwind deterministic across replays.
- Hold the unwind in a single SQL transaction per `VirtualChainChanged` event. If the transaction aborts, leave the previous committed state intact and re-request the same notification on resume.

## POI re-anchoring

POI = `blake2b-256(prior_poi || sorted_canonical_entity_state)`. After an unwind, the surviving POI is the checkpoint at the *latest committed block that survived the reorg* — i.e. the highest `daa_score` block whose hash is not in any `removed_chain_block_hashes` set since genesis.

Concretely, the resume rule is:

1. Find `MAX(daa_score)` row in `kasgraph_poi` whose `block_hash` is still present in `kasgraph_rpc_block_audit` after the unwind. Call its POI hash `P*`.
2. Replay `addedChainBlockHashes` in order, feeding each into the POI chain starting from `P*`. The first new POI is `blake2b-256(P* || canonical_state_after_first_added)`.
3. The terminal POI after replay is the new committed POI. It is identical to what a from-genesis re-ingest of the same final DAG would produce, by induction on the hash chain. This is the **replay-safety contract**: same chain bytes → same Postgres state → same POI hash, even if reorgs happened during live ingest.

## Why recursive lineage proofs are an anti-pattern on a BlockDAG

A recursive lineage proof (state at step N is a function of the *proof* of state at step N-1, not the state itself) interacts badly with reorgs:

- A reorg that swaps blocks at depth D requires re-validating every proof from D+1 to the tip — and on a BlockDAG, "depth" is multi-dimensional. There's no single chain of proofs to walk.
- Cross-input cov-context (`OpInputCovenantId`, `OpCovInputCount`) lets KIP-20 covenants carry *state* directly, not proofs of state. The lineage tracker reads the state from the chain; it never re-derives it.

KasGraph's `kasgraph_covenant_lineage_row` model captures this: each row is one transition with the full post-state bytes spliced inline. Rolling a lineage back is `DELETE WHERE seq > unwind_seq`. There is no proof chain to invalidate.

## Recovery on missed events

A subscription gap can hide both adds and removes. The `RecoveryRequired { from_daa, to_daa }` notification triggers:

1. `kasgraph-rpc::recover_blocks_by_hashes` (when the gap is small and the hashes are known) or a `getBlocks` range fetch (when only DAA bounds are known).
2. For every recovered block, compare the local `kasgraph_rpc_block_audit` state with the fetched block hash. Any local row whose hash is no longer on the canonical VSPC for that DAA is treated as a removed-chain hash and fed into the unwind procedure above.
3. Resume live tailing only after the recovered range is fully ingested.

Gap recovery is intentionally bounded — by default, recovery covers at most `KASGRAPH_RECOVERY_MAX_BLOCKS` (default 5,000) blocks. A gap larger than that is escalated as a restart-from-pruning-point event rather than handled inline.

## What the current scaffold does and does not handle

| Concern | Current behaviour |
| --- | --- |
| Probabilistic buffering | Yes — `IngestionState::probabilistic` BTreeMap keyed on DAA score. |
| Promotion on finality | Yes — `BlockAdded { is_finalized: true }` flushes the probabilistic prefix. |
| Probabilistic conflict rollback | Yes — `remove_probabilistic_by_hashes` + `remove_probabilistic_in_range`. |
| Committed-state SQL unwind | **Not yet** — logged and ignored; the schema columns to support it land alongside the unwind migration. |
| POI re-anchoring after unwind | **Not yet** — requires committed-state unwind to be live first. |
| Recovery range request | Yes — `RecoveryRequired` is produced, env-driven replay hashes are honoured. |
| Continuous wRPC subscription | **Bootstrap only** — subscribe + initial read loop; the long-lived loop lands next. |

The phased approach is deliberate: probabilistic state is in-memory only, so the cost of getting the buffering wrong is bounded. Committed-state unwind touches Postgres, so it ships behind a deeper test fixture (Phase 2.4 `sqlx::test`).

## Source-of-truth

- KIP-20 finality section — `references/kips/kip-0020.md` (sibling OpenSilver repo).
- `kaspanet/rusty-kaspa` `consensus/` crate — definitive GHOSTDAG + VSPC semantics.
- `kaspanet/rusty-kaspa` `consensus/notify/` — wire shape of `virtualChainChanged` and `blockAdded` notifications. Mirrored in `docs/references/KASPA_RPC_REFERENCE.md`.
- The Graph's `graph-node` reorg handling — model for the rollback pattern, adapted to BlockDAG instead of single-chain. See `docs/references/THEGRAPH_REFERENCE.md` for the comparison.
- `crates/kasgraph-rpc/src/lib.rs` — `ChainNotification` enum and notification parsers.
- `crates/kasgraph-node/src/main.rs` — `IngestionState` and `ingest()` transition function.
