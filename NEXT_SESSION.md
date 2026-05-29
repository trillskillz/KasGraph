# Next-session queue

Autonomous work picked up by the next agent run. Phases 1–4 and 6 are substantially landed (113 cargo + 172 TS green; the example-build suite was added this arc and the example dirs regenerate `src/generated/` so the headline count moves with codegen). The **Phase 2.6 WASM mapping runtime is real** — `kasgraph-mapping` runs subgraph mappings deterministically on wasmtime (fuel-metered, NaN-canonicalized, fresh `Store` per block), with a concrete host/guest ABI that now includes **entity reads** (`kasgraph.store_get`). **Spend-semantic payload codegen** types `CovenantSpent` payloads as `{ spend: CovenantSpend; state }`. **`kasgraph build` compiles AssemblyScript mappings to ABI-compliant wasm** via `asc`, and **all six `examples/` mappings are now ported to AssemblyScript** against the new `@kasgraph/as-mapping` SDK and compile end-to-end (`tests/examples-build.test.ts`). The next track that unblocks real deployment: load each subgraph's built wasm in `kasgraph-node` and dispatch detector events through it (seed `store_get` from committed entity state, persist emitted `EntityOp`s); then `deploy`/`status`/`logs`/`remove` + Phase 5 hosted infra. Other autonomous tracks (need network/Postgres to verify): live-node wRPC recovery validation, real-Postgres `sqlx::test` coverage, real OpenSilver compiled-byte sync.

## Latest commit arc (2026-05-29 — POI chain verifier, the third-party verify side)

The `kasgraph-poi` module doc states its purpose is to "allow third parties to verify indexer correctness," but only the *compute* side existed (`compute_poi` / `canonical_block_bytes` / `canonical_json` / `poi_hex`). The *verify* side a third party actually runs was missing. This adds it. Commit `f7c34d5` (`kasgraph-poi`). Fully pure + unit-tested — no Postgres.

- **`verify_poi_chain(&[PoiCheckpoint]) -> Result<PoiVerification, PoiError>`** — recomputes a published chain from genesis (`[0u8; 32]`), checking each `PoiCheckpoint { canonical_entity_bytes, expected_poi }`. Returns `PoiVerification::Valid { final_poi }` when every published POI matches recomputation, or `Diverged { index, expected, recomputed }` pinpointing the first block that doesn't. Empty chain → `Valid` at the genesis prior.
- **`poi_from_hex(&str) -> Result<PoiHash, PoiError>`** — inverse of `poi_hex`, for reading checkpoints off a status page / another indexer's published chain. Rejects non-hex and wrong-length input with `PoiError::InvalidHex` (the new variant alongside `EmptyEntityBytes`).
- **+7 tests → POI at 17:** hex round-trip + bad-hex + wrong-length rejection, empty-chain-verifies, honest-chain-verifies, tampered-checkpoint-diverges-at-its-index, and an end-to-end test running entities → `canonical_block_bytes` → chain → `verify_poi_chain == Valid`.
- **Remaining (Postgres-gated): node wiring.** Same gate as the canonical-encoding arc below — feed `verify_poi_chain` from stored committed-block POIs + recomputed canonical bytes over dispatched entities. The verifier itself is complete and pure; what's missing is a real chain of *published* POIs to verify, which only exists once the node computes POI over real dispatched entity state (post-dispatch, Postgres-backed).

## Previous commit arc (2026-05-29 — ledger replay primitive for both legacy ledgers)

Both legacy ledgers' docs claimed "state is a pure function of the accepted op stream" (the basis of the reorg model) but had no `replay` entry point or test pinning it. This adds both. Commit `d593819` (`kasgraph-detectors`). Fully pure + unit-tested now — no Postgres or address resolution needed (senders are already-resolved strings in the journaled stream).

- **`Krc20Ledger::replay` / `Krc721Ledger::replay`** — `replay<'a, I: IntoIterator<Item = (&'a Inscription, &'a str)>>(ops) -> Self` folds `apply` over an ordered accepted-op stream. This is exactly what the node calls after `unwind_krc*_legacy_ledger` (which deletes the reorged DAA suffix) and on startup: rebuild the in-memory ledger by replaying surviving journal rows in acceptance order.
- **Reorg-survivor property test (each ledger)** — builds a DAA-tagged op stream, filters to rows below a cutoff (modelling the unwind delete), replays the survivors, and asserts the rebuilt state equals the surviving prefix (transfer/mint dropped, earlier ops intact). Plus a `replay == incremental apply` sanity test. +4 → detectors at **69**.
- **Why every survivor re-applies as `Accepted`:** a reorg deletes a DAA *suffix*, and a tick/collection's deploy always precedes its mints/transfers, so any surviving prefix is self-consistent — the journal never contains an orphaned mint whose deploy was cut.
- **Remaining for the rebuild path (Postgres-gated): the node glue + the store fetch.** A `fetch_krc20_legacy_ops_ordered` / `fetch_krc721_legacy_ops_ordered` store read (order by `(accepting_daa_score, tick, seq)`; intra-tick order preserved, inter-tick order is irrelevant since ticks don't interact), and a node-side record→inscription reconstruction (inverse of the parser, reading the stored `op`/`token_id`/`recipient`/`uri`/`max` columns) that feeds `replay`. Both are pure-ish but the fetch's row-mapping (and the actual reorg/startup call site) need Postgres to exercise, and live ingestion of new ops still needs the sender (input→address) resolver — the shared blocker below.

## Previous commit arc (2026-05-29 — legacy KRC-721 ledger journal table + reorg unwind)

The store-side durable journal behind the pure `Krc721Ledger`, the NFT parallel of `kasgraph_krc20_legacy_ledger`. Commit `4a35e11` (`kasgraph-store`). SQL-builder/struct tested only — end-to-end needs Postgres (the established discipline for this crate).

- **`kasgraph_krc721_legacy_ledger`** (new migration `20260529130000`) — records every accepted NFT op (deploy/mint/transfer/burn). Legacy KRC-721 state is a pure function of the accepted op stream, so per-token ownership is rebuilt by replaying these rows in acceptance order; reorg deletes rows at/above the reorged DAA and re-replays survivors. Keyed globally by `(tick, accepting_block_hash, seq)` (a collection tick is global across the Kasplex view — same global-keying choice as the lineage / legacy-KRC-20 tables); the `subgraph` column scopes only reorg unwind. `UNIQUE (tx_hash)` is the replay idempotency key. **`token_id`/`max_supply` are TEXT decimal strings, not BIGINT** — KRC-721 ids and collection sizes are u64 and can exceed `i64::MAX` (same rationale as legacy-KRC-20 amounts).
- **`Krc721LegacyOpRecord`** + four `Store` methods mirroring the KRC-20 set: `record_krc721_legacy_op` (`ON CONFLICT (tx_hash) DO NOTHING`), `krc721_legacy_op_exists`, `next_krc721_legacy_seq` (per-tick `MAX(seq)+1`), `unwind_krc721_legacy_ledger`. 2 SQL-builder tests + migrator bumped to 6 → kasgraph-store at **17**.
- **Design note:** the reference (`:74`) names `kasgraph_krc721_legacy_token` (current owner) + `_transfer` (history) head tables. Those are a **query-layer projection** over this journal — they land with the GraphQL/MCP consumer, not the indexing path. The journal is the single durable replayable record, exactly as the KRC-20 slice kept balances in the in-memory ledger rather than a store head table. Symmetry across the two legacy protocols.
- **Next slice (the last legacy-KRC-721 piece, Postgres-gated): node wiring.** Shares the sender-resolution blocker with legacy KRC-20: scan `committed.block.payloads`, `parse_krc721_inscription`, resolve sender (= first input's address, needs input→address resolution the wire model lacks), `krc721_legacy_op_exists` → `next_krc721_legacy_seq` → `Krc721Ledger::apply`; on `Accepted`, `record_krc721_legacy_op`. On reorg, `unwind_krc721_legacy_ledger` + re-replay. A `fetch_krc721_legacy_ops_ordered` read lands with this wiring.

## Previous commit arc (2026-05-29 — legacy KRC-721 inscription parser + ownership ledger)

The NFT parallel to the four legacy-KRC-20 slices below. Both pure, storage-agnostic, fully unit-tested without Postgres — the same "pure core first" discipline. Commit `7f30d30` (`kasgraph-detectors`).

- **`kasgraph-detectors::krc721`** — `parse_krc721_inscription(payload) -> Krc721Parse` for the Kasplex-era `{"p":"krc-721","op":...}` payload envelope (per `KRC20_KRC721_REFERENCE.md:58-74`). `Krc721Op` tagged enum: `deploy`=max, `mint`=id+uri, `transfer`=id+to, `burn`=id. Strict decimal-u64 for `max`/`id`; lowercase-ASCII tick normalization with `tick_raw` preserved. Three-way `NotKrc721`/`Malformed(reason)`/`Valid` outcome (mirrors `Krc20Parse`). Mint requires a non-empty `uri`; transfer requires a non-empty `to`.
- **`kasgraph-detectors::krc721_ledger`** — `Krc721Ledger::apply(&inscription, sender) -> ApplyOutcome` re-derives per-token ownership over a `BTreeMap<tick, CollectionState>`. `CollectionState` = `max` + `owners: BTreeMap<id, owner>` (live tokens) + `minted: BTreeSet<id>` (every id ever minted). Rules: **deploy** first-writer-wins; **mint** requires `id < max` AND the id has never been minted (uniqueness is *permanent* — a burned id stays in `minted` so it can never be re-minted); **transfer**/**burn** require the sender to currently own the token. 21 unit tests across both modules → detectors at **65**.
- **Next slices (Postgres-gated): store tables + node wiring.** `kasgraph_krc721_legacy_token` keyed `(tick, token_id)` with an owner column + a `kasgraph_krc721_legacy_transfer` history table (`KRC20_KRC721_REFERENCE.md:74`). Then node wiring: scan payloads, `parse_krc721_inscription`, resolve sender (= first input's address — the same input→address sub-dependency the KRC-20 wiring needs), `Krc721Ledger::apply`, persist accepted ops + reorg replay. Shares the sender-resolution blocker with legacy KRC-20.

## Previous commit arc (2026-05-29 — Phase 2.8 POI canonical block-state encoding)

The POI scaffold computed `blake2b-256(prior_poi || bytes)` but left the "sorted canonical" entity-state encoding undefined (it accepted pre-canonicalized bytes). This defines it — the missing Phase 2.8 piece. Pure + fully unit-tested. Commit `1c992e5` (`kasgraph-poi`).

- **`canonical_block_bytes(&[CanonicalEntity]) -> Vec<u8>`** — the deterministic input to `compute_poi`. Two honest indexers that processed the same committed block must produce byte-identical bytes here, so their POI chains agree and a third party can verify either. Pins every degree of freedom: entities sorted by `(entity_type, entity_id)` (collection order irrelevant); each JSON state canonicalized via `canonical_json` (object keys recursively sorted, compact — independent of Postgres JSONB key ordering; array order preserved as semantic); every field length-prefixed (u32-le) so adjacent fields can't be reinterpreted as a different split; entity count prefixed so an empty block still hashes to a well-defined non-empty value (the chain advances every block).
- **`canonical_json(&Value)`** + `CanonicalEntity` type. 7 new tests (key-order independence, array-order preservation, input-order independence, length-prefix disambiguation, empty-block count prefix, distinct-state distinctness) → kasgraph-poi at **10**. `serde_json` added to the crate.
- **Next slice (Postgres-gated): node wiring.** The node currently feeds `BootstrapBlock.canonical_entity_bytes` from an env scaffold (`KASGRAPH_BOOTSTRAP_ENTITY_BYTES`). Replace it with `canonical_block_bytes` over each committed block's *dispatched* entities. The catch: those entities come from `dispatch_committed_hits` seeded by `Store::snapshot_entities` (Postgres), and POI is currently computed in `block_from_rpc` *before* dispatch — so wiring real canonical bytes means computing POI after dispatch, which needs a real DB to verify end-to-end. Pairs naturally with the `sqlx::test` coverage item.

## Previous commit arc (2026-05-29 — legacy KRC-20 ledger journal table + reorg unwind)

Fourth legacy-KRC-20 slice: the store-side durable journal behind the pure `Krc20Ledger`. Commit `d629b02` (`kasgraph-store`). SQL-builder/struct tested only — end-to-end needs Postgres (the established discipline for this crate).

- **`kasgraph_krc20_legacy_ledger`** (new migration `20260529120000`) — the journal of accepted Kasplex-era inscription ops. Legacy KRC-20 state is a pure function of the accepted op stream, so the ledger is reconstructed by replaying these rows in acceptance order (`KRC20_KRC721_REFERENCE.md:54`). Keyed globally by `(tick, accepting_block_hash, seq)` (a tick is global across the Kasplex view — same global-keying choice as the lineage tables); the `subgraph` column scopes only reorg unwind. `UNIQUE (tx_hash)` is the replay idempotency key (one inscription per tx payload). **Amounts (`amount`/`max_supply`/`mint_limit`) are TEXT decimal strings, not BIGINT** — KRC-20 amounts are u64 and can exceed `i64::MAX`, so BIGINT would silently corrupt large values; replay re-parses via the envelope parser's strict decimal-u64 path.
- **`Krc20LegacyOpRecord`** + four `Store` methods: `record_krc20_legacy_op` (idempotent insert, `ON CONFLICT (tx_hash) DO NOTHING`), `krc20_legacy_op_exists(tx_hash)` (pre-seq replay guard, mirrors `covenant_lineage_row_exists`), `next_krc20_legacy_seq(tick)` (per-tick `MAX(seq)+1`, `0` for a fresh tick), `unwind_krc20_legacy_ledger(subgraph, from_daa)` (subgraph + DAA-cutoff delete). 2 SQL-builder tests + migrator bumped to 5 → kasgraph-store at **15**.
- **Next slice (the last legacy-KRC-20 piece, Postgres-gated): node wiring.** In the committed loop, scan `committed.block.payloads`, `parse_krc20_inscription`, resolve the sender (= first input's address — needs prior-output `scriptPublicKey` → address resolution, which the wire model doesn't carry yet, so that's a sub-dependency), call `krc20_legacy_op_exists` → `next_krc20_legacy_seq` → `Krc20Ledger::apply`; on `Accepted`, `record_krc20_legacy_op`. On reorg, `unwind_krc20_legacy_ledger` then re-replay the surviving stream to rebuild the in-memory ledger. A `fetch_krc20_legacy_ops_ordered` read method lands with this wiring (the consumer that needs it).

## Previous commit arc (2026-05-29 — legacy KRC-20 ledger acceptance state machine)

Third legacy-KRC-20 slice: a **pure** (no-Postgres) state machine that applies the Kasplex inscription rules over a stream of `(Krc20Inscription, sender)`. Commit `83fd12f` (`kasgraph-detectors::krc20_ledger`).

- **`Krc20Ledger`** — `apply(&inscription, sender) -> ApplyOutcome` dispatching deploy/mint/transfer/burn over a `BTreeMap<tick, TokenState>`. Rules: **deploy** first-writer-wins (a second deploy of the same tick is `Rejected("tick already deployed")`); **mint** requires `amt <= lim` AND `minted + amt <= max` (rejected *wholesale*, never partial), then credits sender + bumps `minted`; **transfer** requires `sender_balance >= amt`; **burn** requires `sender_balance >= amt`, then decrements *both* balance and `minted` (saturating) so the `supply == sum(balances)` invariant holds. Zero-balance entries pruned on debit.
- **`TokenState`** exposes `max`/`lim`/`minted`/`balances`; `ApplyOutcome` is `Accepted` | `Rejected(&'static str)`. 11 unit tests cover each rule, each rejection path, and the supply invariant → detectors at **44**.
- **Sender** = the tx's first input address; resolving it at wire time still needs input→address resolution (prior-output `scriptPublicKey` → address), deferred to node wiring.
- **Next slices (in order, both need Postgres to verify):** (1) a dedicated `kasgraph_krc20_legacy_ledger` store table keyed `(tick, accepting_block_hash, seq)` with **reverse-acceptance-order** reorg unwind — the lineage-row model does NOT apply (`KRC20_KRC721_REFERENCE.md:54`). (2) node wiring: scan `committed.block.payloads`, `parse_krc20_inscription`, resolve sender, `Krc20Ledger::apply`, persist accepted ops + reorg-unwind.

## Previous commit arc (2026-05-29 — tx payloads in the wire model for legacy KRC-20)

Second legacy-KRC-20 slice: the inscription parser (below) had nothing to read because the wire model carried only outputs + inputs. Commit `9394e8c` (`kasgraph-rpc`, with literal-site updates in `kasgraph-node`).

- **`IngestedTransactionPayload`** (`tx_hash` + decoded `payload` bytes) + **`IngestedBlock.payloads`**, populated by a new resilient `extract_transaction_payloads`: only transactions with a non-empty, hex-decodable `payload` field appear, in transaction order (so the ledger applies ops in order); the common empty-payload case is omitted to keep the model lean. Mirrors the input/output extractors' skip-don't-fail shape. `tx_hash` lets the ledger associate the op with the tx (and, via the block's inputs, the sender). 2 parse tests (extraction/order, non-hex skip) → rpc at 32.
- **Note:** `block_to_rpc` sets `payloads` empty for now (the `BootstrapBlock` scaffold path doesn't carry payloads, same as `inputs` were initially). Payloads flow from the RPC fetch path (`parse_block_value`), which is what the ledger consumes.
- **Next slices (in order):** (1) a **pure ledger acceptance state machine** in `kasgraph-detectors` (or a new module) applying the Kasplex rules over a stream of `(Krc20Inscription, sender)` — deploy first-writer-wins; mint `cumulative_minted + amt <= max && amt <= lim`; transfer `sender_balance >= amt`; burn decrements both — returning accept/reject per op. This is unit-testable WITHOUT Postgres (pure state transition), so it's the next "pure core" slice. Sender = the tx's first input address, so wiring later needs input→address resolution (the wire model has the input outpoints; resolving them to addresses needs the prior output's scriptPublicKey → address, a separate concern). (2) a dedicated `kasgraph_krc20_legacy_ledger` store table keyed on `(tick, accepting_block_hash, seq)` with reverse-acceptance-order reorg unwind (the lineage-row model does NOT apply — `KRC20_KRC721_REFERENCE.md:54`). (3) node wiring: scan `committed.block.payloads`, parse, apply to the ledger. Steps 2-3 need Postgres to verify end-to-end.

## Previous commit arc (2026-05-29 — legacy KRC-20 inscription envelope parser)

Legacy (Kasplex-era) KRC-20 operations are **JSON inscriptions in the transaction payload field** (protocol-observable), not covenant scripts — the unblocked alternative to the native `operation` decoder (blocked on OpenSilver script semantics). Commit `ebed8bf` (`kasgraph-detectors`).

- **`kasgraph-detectors::krc20`** — pure `parse_krc20_inscription(payload: &[u8]) -> Krc20Parse` for the `{"p":"krc-20","op":"deploy|mint|transfer|burn",...}` envelope (per `KRC20_KRC721_REFERENCE.md:21-56`). Three-way outcome: `NotKrc20` (not a KRC-20 payload — ignored silently, the common case), `Malformed(reason)` (claims `p == "krc-20"` but violates a precondition — dropped, caller logs at debug), `Valid(Krc20Inscription)`. Amounts are strict decimal u64 strings (reject signs/decimals/hex/`>u64::MAX`); ticks normalize to lowercase ASCII with `tick_raw` preserved. `Krc20Op` is a tagged enum carrying per-op fields. 10 unit tests → detectors at 33.

## Previous commit arc (2026-05-29 — KIP-20 lineage population made replay-safe)

Follow-up hardening on the population slice below (commit `566c3c1`, `kasgraph-node` + `kasgraph-store`).

- **Bug:** reconnect re-delivery can re-present an already-ingested hit (the reason `track_covenant_utxo` / `record_covenant_spend` are idempotent). `persist_lineage` was not — replaying a hit re-fetched the *advanced* head and appended a phantom transition at the next `seq`, inflating `lineage_count` and the history.
- **Fix:** a covenant output is exactly one lineage step, so `(covenant_id, tx_hash, output_index)` is a sound idempotency key. `persist_lineage` now returns early when that step already exists (`Store::covenant_lineage_row_exists`), and a `UNIQUE (covenant_id, tx_hash, output_index)` constraint enforces it at the schema level (and indexes the lookup). 145 cargo + 173 TS tests green; fmt + clippy clean.

## Previous commit arc (2026-05-29 — KIP-20 lineage head + rows populated)

The covenant lineage tables (`kasgraph_covenant_lineage_head` / `_row`) were created in the first store migration but never written; now that `covenant_id` is real (prior arc), the node populates them. One commit (`665124c`, `kasgraph-node` + `kasgraph-store`).

- **classification** — `assign_covenant_id` became `classify_lineage`, returning a `LineageClass::{Genesis(id), Transition(id)}` verdict so the node knows whether a hit opens or continues a lineage (the id alone hid that distinction).
- **population** (`persist_lineage`, gated on a loaded mapping) — each detector hit opens (genesis) or advances (transition) the head and appends the next per-transition row. `seq` == the prior head's `lineage_count` (genesis → seq 0/count 1; each transition increments by one, per `KIP20_COVENANT_ID_QUERIES.md:109`). Factored into a pure `next_lineage_step(prior_count) -> (seq, count)` with 2 unit tests. `state_bytes` carries the detector payload as JSON for state replay.
- **schema** — lineage is keyed globally by `covenant_id` (matching the MCP `get_covenant_lineage` + GraphQL consumers, which take no subgraph filter). Added a `subgraph` column to both tables (+ a `(subgraph, daa_score DESC)` index) used *only* to scope reorg unwind; amended the existing migration since there's no Postgres to migrate. New `Store::fetch_covenant_lineage_head(covenant_id)`.
- **reorg safety** — new `Store::unwind_covenant_lineage(subgraph, from_daa)` runs atomically: delete this subgraph's rows at/above the cutoff, drop heads with no surviving row, then re-point each surviving head at its highest-`seq` surviving row (restoring `current_utxo`/`last_seen_daa`/`lineage_count`). Wired into the node reorg path alongside the utxo/spend unwinds, so the lineage view never exposes a transition the surviving chain dropped.
- **Net:** the `get_covenant_lineage` MCP tool + GraphQL `lineage` connection now have real data to read once Postgres is present. 145 workspace tests green; fmt + clippy clean (only pre-existing drift). Population/unwind are DB-dependent so they need Postgres to exercise end-to-end (the pure seq arithmetic is unit-tested).
- **Remaining — still the `operation` decoder** (unchanged from below): per-pattern covenant script semantics not in the repo. Plus real-Postgres `sqlx::test` coverage and `deploy`/`status`/`logs`/`remove` CLI + Phase 5.

## Previous commit arc (2026-05-28 — covenant-id + lineage assignment subsystem)

KasGraph now computes covenant ids and the lineage model itself (RPC doesn't expose them; `KASPA_RPC_REFERENCE.md:443` delegates this to the indexer). Three commits.

- **covenant-id derivation** (`ff9d26a`, `kasgraph-detectors`) — `genesis_covenant_id(tx, output)` = domain-separated (`kasgraph.covenant_id.v1`), versioned blake2b-256 over the genesis outpoint, hex-encoded (64 chars). Established once at genesis, inherited unchanged across the lineage. Pure + 4 unit tests (determinism, outpoint/index distinctness, domain separation) → detectors at 23. **Design commitment:** this defines KasGraph's covenant_id; if a real KIP-20 consensus id ever appears via RPC, bump the domain version and migrate.
- **lineage assignment in the node** (`4ea7fc6`, `kasgraph-node`) — `assign_covenant_id(store, subgraph, hit, inputs)` classifies each hit: if its tx consumes a tracked covenant UTXO → transition (inherit the predecessor's id); else → genesis (fresh id). The assigned id flows to both the detected-pattern row and the tracked UTXO, so the previously-`None` covenant_id is now real and spends inherit it. Gated on a loaded mapping (no-mapping path unchanged).
- **successor resolution** (`edcb6b7`, `kasgraph-node` + `kasgraph-store`) — `successorCovenantId` on a detected spend = the spent covenant's id when the spending tx produced a tracked same-id covenant output (`Store::covenant_lineage_continues`, an `EXISTS` over `covenant_utxos`), else `None`. Correct within a block because the lock loop (which tracks the continuation output) precedes the spend loop, and a spend + its successor share a transaction. New `successor_covenant_id` column on `covenant_spends`.
- **Net:** the `CovenantSpend` envelope is now honestly complete **except `operation`**. 143 workspace tests green; fmt clean. The genesis-vs-transition path needs Postgres to exercise end-to-end (unit tests cover the pure derivation; the classification reads the DB).
- **Remaining — the operation decoder only.** `operation` (transfer/mint/burn/redeem) needs per-pattern covenant **script semantics** not in the repo (OpenSilver compiled bytes are placeholders; KCC20 operation decode unbuilt). A coarse continue/terminate binary is derivable from successor presence, but the example mappings branch on specific strings, so a coarse value would mislead — deferred. Once a real operation is derivable, fill it on the `CovenantSpendRecord`, build the `CovenantSpend` envelope from the now-complete row, resolve the `CovenantSpent` handler via the descriptor (keyed on `detector_kind`), seed prior state from the matched `locked_state`, and call `dispatch_spend_hit` (`412de54`) in place of the `info!` log. Plus: real-Postgres `sqlx::test` coverage, and `deploy`/`status`/`logs`/`remove` CLI + Phase 5.

## Previous commit arc (2026-05-28 — detected covenant spends persisted)

Detected spends are now durable, not just logged (commit `50869a4`, `kasgraph-store` + `kasgraph-node`).

- New per-subgraph `covenant_spends` table (PK `(spending_tx_hash, previous_tx_hash, previous_output_index)`; `block_daa_score`, `detector_kind`, `covenant_id`, `spent_value_sompi`). `CovenantSpendRecord` + `record_covenant_spend` (idempotent on the spending input) + `unwind_covenant_spends`.
- **Two-table reorg model:** `covenant_utxos` is the immutable lock-time set (unwound when the *lock* block reorgs); `covenant_spends` is keyed on the *spending* block's DAA (unwound when the *spend* block reorgs). So a reorg that drops only the spend block rolls back the spend row and restores spend-detectability for its outpoints, while the earlier UTXO row survives. Both unwinds run in the node's reorg path at the same cutoff.
- Every persisted column is protocol-observable at detection time, so the row is honest today — `operation` / `successorCovenantId` are deliberately absent (they need the spend-tx decoder). 2 SQL-builder tests → kasgraph-store at 12; 139 workspace tests green; fmt clean (detectors drift untouched).
- **Remaining for dispatch unchanged:** the spend-tx decoder for `operation` + `successorCovenantId`. With spends now persisted, a future option is to dispatch `CovenantSpent` directly off the `covenant_spends` row once the decoder fills those two fields (`spentValueSompi` and the rest are already there).

## Previous commit arc (2026-05-28 — spent value captured in the covenant-UTXO tracker)

Honest, protocol-observable groundwork for the `CovenantSpend` envelope (commit `2dcf7b6`, `kasgraph-store` + `kasgraph-node`).

- The locked output's value is observable at lock time, so recording it lets a detected spend report `spentValueSompi` **honestly** — no spend-tx decoder needed for this field. Added `value_sompi BIGINT NOT NULL` to the `covenant_utxos` table, `CovenantUtxoRecord`, and `CovenantUtxoMatch`.
- The node derives `value_sompi` from the locking block's output whose `(tx_hash, output_index)` matches the `CovenantLocked` hit (falls back to 0 if absent), and surfaces it on the spend-detection `info!` log.
- 137 workspace tests green; `cargo fmt` clean (except the pre-existing detectors drift, intentionally untouched).
- **Remaining for `CovenantSpent` dispatch now narrows to two fields:** `operation` and `successorCovenantId`, which genuinely need a spend-transaction decoder (read the spending tx + KIP-20 lineage head). Once those are honestly derivable, build the `CovenantSpend` envelope `{ operation, spentValueSompi: <from the match>, successorCovenantId }`, resolve the `CovenantSpent` handler via the descriptor keyed on the matched `detector_kind`, seed prior state from the matched `locked_state`, and call `dispatch_spend_hit` (`412de54`) in place of the `info!` log.

## Previous commit arc (2026-05-28 — covenant-UTXO tracker wired into the node)

Spend **detection** is now wired end-to-end through the node; spend **dispatch** stays deferred behind a missing decoder (see below). Two commits this arc.

- **Store layer** (commit `4e823d0`, `kasgraph-store`) — per-subgraph `covenant_utxos` table (PK `(tx_hash, output_index)`; `block_daa_score`, `detector_kind`, `covenant_id`, `locked_state` JSONB) created by `ensure_subgraph_schema`. `CovenantUtxoRecord` / `CovenantUtxoMatch` value types + `track_covenant_utxo` (upsert on outpoint, idempotent for replay), `lookup_covenant_utxo(subgraph, tx_hash, output_index)`, `unwind_covenant_utxos(subgraph, from_daa)`. Three injection-safe SQL builders (validated `SubgraphId` schema name). 3 unit tests → kasgraph-store at 10.
- **Node wiring** (commit `6930ebd`, `kasgraph-node`) — threads `inputs` through `BootstrapBlock` / `block_from_rpc` / `block_to_rpc`. On each `CovenantLocked` hit (gated on `KASGRAPH_SUBGRAPH_DIR` via `mapping.is_some()`), persists a `CovenantUtxoRecord` (`locked_state` = the hit payload). After applying a block, scans its inputs against the tracker via `lookup_covenant_utxo` — **placed outside the `!hits.is_empty()` guard** so a spend in a block that locks no new covenant is still caught — and emits an honest `info!` on a match. Reorg path unwinds `covenant_utxos` alongside entity versions. +1 threading assertion → node at 49; 137 workspace tests green. Same commit folds in `cargo fmt` cleanup of previously-committed rpc/store/mapping_host code.
- **Why dispatch is still deferred (the one remaining piece):** `CovenantSpent` example mappings branch on `spend.operation` / `successorCovenantId`, and there is **no spend-transaction decoder** yet to derive those (or the spent value) honestly. Feeding a placeholder would corrupt every spend mapping, violating the project's honesty principle. So the matching is wired and logged but `dispatch_spend_hit` (`412de54`) stays ready/dead_code.
- **Next slice — the spend-tx decoder.** Build a decoder that reads the spending tx (+ KIP-20 lineage head) to produce `operation` / `successorCovenantId` / `spentValueSompi`. Then in the node's input-scan block, replace the `info!` log with: build the `CovenantSpend` envelope from the decoded fields, resolve the `CovenantSpent` handler via the descriptor (keyed on the matched lock's `detector_kind`), seed prior state from the matched `locked_state`, and call `dispatch_spend_hit`. All other plumbing is done. Then: real-Postgres `sqlx::test` coverage, and `deploy`/`status`/`logs`/`remove` CLI + Phase 5.

## Previous commit arc (2026-05-28 — transaction inputs in the wire model)

The first foundational slice toward *wiring* spend dispatch is landed (commit `d9ec50c`, `kasgraph-rpc`). The block wire model carried transaction outputs only; it now carries inputs too.

- **`IngestedTransactionInput`** (`spending_tx_hash` + `previous_tx_hash` + `previous_output_index`) and an `inputs: Vec<…>` field on `IngestedBlock`, populated by a new resilient `extract_transaction_inputs` that walks each tx's `inputs[].previousOutpoint`. Mirrors the output extractor's resilience: an input without a parseable `previousOutpoint` is skipped; coinbase inputs (zero previous tx id) are kept but inert (spend matching never tracks a zero-hash UTXO).
- `block_to_rpc` sets `inputs` empty for now — `BootstrapBlock` doesn't carry inputs yet (next sub-slice).
- 3 parse tests → kasgraph-rpc at 30; workspace green, warning-clean.
- **Next sub-slices to make spends actually dispatch (in order):** (1) add `inputs` to `BootstrapBlock` + populate it in `block_from_rpc` so inputs reach the committed loop; (2) a **covenant-UTXO tracker** — when a `CovenantLocked` detector hit fires, its output `(tx_hash, output_index)` is a covenant UTXO; persist a `(tx_hash, output_index) → {kind, covenant_id, locked_state_payload}` lookup (new store table + SQL builders, unit-testable like `entity_versions`; the `kasgraph_covenant_lineage_*` tables are related but track lineage heads, not the outpoint→covenant lookup spend matching needs); (3) in the committed loop, for each block input look up `(previous_tx_hash, previous_output_index)` against the tracker — a hit is a spend; build the `CovenantSpend` envelope (operation/spentValueSompi from the spend tx, successorCovenantId from lineage), resolve the `CovenantSpent` handler via the descriptor (keyed on the *locked* covenant's kind), and call `dispatch_spend_hit`. Needs Postgres to verify end-to-end.

## Previous commit arc (2026-05-28 — spend-dispatch core, CovenantSpent)

The deterministic core for dispatching covenant **spends** is landed (commit `412de54`, `kasgraph-node::mapping_host`), symmetric to the locked path and ahead of the input-scanning wire change that will feed it — same "pure core first" pattern the locked bridge used.

- **`EVENT_COVENANT_SPENT`** added to `subgraph_manifest` (`#[allow(dead_code)]` until the wiring resolves it). The *locked* covenant's detector kind resolves the spend handler, so the data source whose `patterns` matched the lock also owns the transition.
- **`CovenantSpend`** envelope (`operation` / `spentValueSompi` / `successorCovenantId`), serde `camelCase` to match the CLI codegen's `CovenantSpend` TS interface — protocol-observable fields only; subgraph quantities stay mapping-derived.
- **`spend_mapping_event(spend, prior_state, daa, hash, handler)`** builds the `{ spend, state }` payload codegen types for spend handlers, wrapping the prior locked detector state under `state`.
- **`dispatch_spend_hit(...)`** runs a compiled mapping for a spend, seeding `store_get` from the committed snapshot, returning DAA-versioned records — mirrors `dispatch_locked_hit`.
- 3 unit tests (payload shape, null successor on lineage termination, snapshot-seeded dispatch via the WAT handler). node at 49 tests; `cargo build --workspace --all-targets` warning-clean.
- **What's left to wire spend dispatch end-to-end (the side-effecting glue this unblocks):** the block model (`BootstrapBlock` / `kasgraph_rpc::IngestedBlock`) currently carries transaction **outputs only**, so the node can detect lock-time covenants but not spends. Wiring needs: (1) transaction **inputs** added to the wire model in `kasgraph-rpc`; (2) a covenant-UTXO tracker — the `kasgraph_covenant_lineage_*` store tables + `upsert_covenant_lineage_head` / `insert_covenant_lineage_row` exist but the node's committed loop doesn't populate them yet; (3) per committed block, match inputs against tracked covenant UTXOs, build the `CovenantSpend` envelope from the spend tx + lineage head, resolve the `CovenantSpent` handler via the descriptor, and call `dispatch_spend_hit`. Needs the wire change + Postgres to verify.

## Previous commit arc (2026-05-28 — WASM dispatch wired into the node ingest loop)

The loop from detector hit to persisted entity state is now closed end-to-end (everything except a live Postgres round-trip, which this environment can't run). Three slices, in order:

- **CLI emits a resolved manifest descriptor** (commit `27a5a76`). `kasgraph build` now writes `build/manifest.json` next to the wasm: `{ name, wasm, dataSources:[{ name, kind, patterns, collection, addresses, handlers:[{event,handler}] }] }`. This keeps the TS CLI the single `subgraph.yaml` parser — the node consumes the JSON with `serde_json`. +1 cli-build test → 173 TS.
- **Node parses the descriptor + resolves handlers** (commit `130efbe`, `kasgraph-node::subgraph_manifest`). `BuildDescriptor::load(dir)` reads `<dir>/build/manifest.json`; `resolve_handler(detector_kind, event)` finds the first data source whose `patterns` include the kind, then its handler for that event (`None` → no mapping handles the hit). 5 unit tests.
- **`LoadedMapping` + live-loop wiring** (commits `429dfee`, `d52614d`, `kasgraph-node::mapping_host`). `LoadedMapping::load(subgraph, dir)` compiles the wasm once; `dispatch_committed_hits(daa, hash, hits, snapshot)` resolves the `CovenantLocked` handler per hit, dispatches seeding `store_get` from the snapshot, and returns `EntityVersionRecord`s (a hit no data source matches is skipped; a handler that fails is logged + skipped so one bad mapping can't stall the indexer). `persist_bootstrap_state` loads an optional mapping from **`KASGRAPH_SUBGRAPH_DIR`** (unset → unchanged behavior); it threads through `apply_and_persist_notification` + `run_continuous_ingestion`. In the committed-writes loop: build the snapshot via `Store::snapshot_entities`, dispatch, persist each record via `Store::upsert_entity_version`. On a committed reorg: `Store::unwind_entity_versions` at/above the lowest unwound DAA. node at 46 tests, workspace warning-clean.
- **What's left to verify / next:** (1) end-to-end against a real Postgres — set `KASGRAPH_DATABASE_URL` + `KASGRAPH_SUBGRAPH_DIR` to a built example and confirm `entity_versions` rows land + unwind on reorg (needs a DB; `sqlx::test` coverage is the durable form). (2) The example mappings only export lock-time (`CovenantLocked`) handlers' worth of logic against detector hits; spend events (`CovenantSpent`) ride the separate KIP-20 lineage path and aren't dispatched yet — wiring spend dispatch is the next functional slice. (3) `deploy`/`status`/`logs`/`remove` CLI commands + Phase 5 hosted infra.

## Previous commit arc (2026-05-28 — detector-hit → mapping → entity-version bridge)

- **`kasgraph-node::mapping_host`** (new module, commit `9c8aa2e`) — the pure, deterministic core of wiring wasm dispatch into the committed ingest loop, landed complete and unit-tested ahead of the side-effecting glue. Three functions: `locked_mapping_event(hit, daa, hash, handler)` (lock-time detector hit → typed `MappingEvent`, hit payload becomes event payload), `entity_versions(outcome, subgraph, daa)` (a dispatch outcome's `EntityOp`s → DAA-stamped `EntityVersionRecord`s, ready for `upsert_entity_version`; a reorg unwinds them by the same score), and `dispatch_locked_hit(...)` (run a compiled `MappingRuntime` against a hit, seeding `store_get` from the committed `EntitySnapshot`, return records + raw outcome; dispatch errors propagate so the caller decides how a bad mapping is handled).
- 4 unit tests: payload/block/handler passthrough, op stamping with subgraph+daa, a WAT-driven end-to-end proving the seeded `("Bond","b1")` snapshot reaches the guest and its emitted op flows back as a versioned record, and ABI-mismatch propagation for an unknown handler. `kasgraph-node` → 38 tests; build warning-clean (the module is `allow(dead_code)` until the live loop calls it).
- **Remaining node wiring (the side-effecting glue this unblocks):** at the committed-block detector-hit loop in `apply_and_persist_notification` (main.rs ~line 822, where each hit becomes a `DetectedPatternRecord`), for each configured subgraph: (1) load its built wasm — convention is `build/<name>.wasm` from the subgraph dir produced by `kasgraph build` — into a `MappingRuntime` once at startup (not per block); (2) resolve which handler to dispatch from the manifest (lock-time hits → the dataSource's `CovenantLocked` handler; spend events are a separate KIP-20 lineage path); (3) build the `EntitySnapshot` via `Store::snapshot_entities` / `latest_entity`; (4) call `dispatch_locked_hit`; (5) persist the returned records via `Store::upsert_entity_version`; (6) call `Store::unwind_entity_versions` on reorg alongside the existing committed-block unwind. Open design decisions before this lands: how subgraph dir / wasm location is configured into the node, manifest parsing on the Rust side (currently only the TS CLI parses `subgraph.yaml`), and Locked-vs-Spent event typing. Needs Postgres to verify end-to-end.

## Previous commit arc (2026-05-28 — entity_versions persistence layer)

- **`kasgraph-store` gains the mapping-output substrate.** The wasm runtime emits `EntityOp`s per dispatch; this layer is where they land, versioned by DAA score so a reorg can unwind them alongside committed blocks. Commit `7acec60`.
- New value types `EntityVersionRecord` (subgraph + entity_type + entity_id + block_daa_score + payload) and `EntitySnapshotRow` (entity_type + entity_id + payload). Four async `Store` methods: `upsert_entity_version` (idempotent on `(entity_type, entity_id, block_daa_score)`), `latest_entity` (highest-DAA row for a key — seeds `store_get` on dispatch), `snapshot_entities` (one row per entity key via `DISTINCT ON ... ORDER BY block_daa_score DESC`), `unwind_entity_versions` (deletes rows at or above a reorg cutoff).
- The per-subgraph `entity_versions` table is created by `ensure_subgraph_schema` (PK `(entity_type, entity_id, block_daa_score)`). Schema name is validated lowercase/digit/underscore, so the `format!`-interpolated table-qualified name is injection-safe — matching the existing pattern in this crate.
- Tests: 4 pure SQL-builder unit tests (no DB needed) → `kasgraph-store` at 7. `cargo test --workspace` green.
- **Next slice (unchanged, now unblocked on the store side):** wire wasm dispatch into `kasgraph-node`'s ingest loop. Load the built module per subgraph, dispatch detector events, seed `store_get` from `snapshot_entities`/`latest_entity`, persist emitted `EntityOp`s as `EntityVersionRecord`s via `upsert_entity_version`, and call `unwind_entity_versions` on reorg alongside the existing committed-block unwind. Needs design decisions (where built wasm lives / how it's configured, manifest→handler-name resolution, Locked-vs-Spent event typing) and Postgres to fully verify.

## Previous commit arc (2026-05-28 — example mappings ported to AssemblyScript)

- **Runtime entity reads.** `kasgraph-mapping` gains a third host import: `kasgraph.store_get(ePtr,eLen,idPtr,idLen) -> i64`. Returns `0` on a miss; on a hit the host re-enters the guest's `kasgraph_alloc`, writes the looked-up entity `data` JSON into guest memory, and returns `(ptr<<32)|len`. New `dispatch_with_entities(event, &EntitySnapshot)` seeds the read set (`HostState.entities`); the borrow dance clones the bytes before re-entering alloc. 2 new WAT-driven tests (hit echoes JSON, miss returns zero) → crate at 12 tests. Commit `eb58b7a`.
- **`@kasgraph/as-mapping` SDK** (new fifth npm workspace package, `as-mapping/assembly/index.ts`). Typed helpers over the host ABI so mappings never touch raw pointers: `decodeEvent(ptr,len): Event` (`daaScore`/`blockHash` + `payload: JSON.Obj|null`), `log(level,msg)`, `store.get(entity,id): JSON.Obj|null` / `store.set(entity,id,data)`, and `objStr`/`objU64`/`objBool` field accessors. JSON via `assemblyscript-json`. `kasgraph build` resolves it + its transitive AS deps by adding every ancestor `node_modules` as an `asc --path` root (asc does not walk up the tree). Commit `fea6f57` (SDK + build resolution); accessor helpers added this arc.
- **All six example mappings ported.** `examples/{kasbonds,krc20,krc721,network-stats,opensilver-patterns,zk-proofs}/src/mapping.ts` rewritten from async TS pseudo-code into compilable AssemblyScript targeting the ABI through the SDK. Each handler is `export function handleX(ptr: i32, len: i32): void`; the build glue re-exports them. They implement the lifecycle logic the pseudo-code described — entity create/update, branch on `spend.operation` / `successorCovenantId`, supply + counter accumulation via `store.get`. Where the pseudo-code referenced data the real event JSON doesn't carry (`tx.hash`, a covenant's own id on its lock-time state), the port keys on `block.hash` / available payload fields; fidelity to the dispatch ABI was prioritized over the aspirational payload shape.
- **`tests/examples-build.test.ts`** runs `runBuild` on every example (cwd = the example dir, inside the repo so the hoisted root `node_modules` is an ancestor) and asserts an ABI-valid wasm: exports `memory` + `kasgraph_alloc` + each manifest handler; imports only `kasgraph.{log,store_set,store_get}`. 6 cases.
- Verification: `npm run typecheck` clean; full `npx vitest run` → 172 TS green (was 166, +6); `cargo test -p kasgraph-mapping` → 12 green.
- **Next slice:** wire wasm dispatch into `kasgraph-node`'s ingest loop — load the built module per subgraph, dispatch detector events, seed `store_get` from committed entity state, persist the emitted `EntityOp`s. That closes the loop to a live subgraph and unblocks `deploy`/`status`/`logs`/`remove`.

## Previous commit arc (2026-05-28 — `kasgraph build` TS→WASM compiler)

- `cli/src/build.ts` (`runBuild`) compiles a subgraph's AssemblyScript mapping into a `.wasm` the Phase 2.6 `kasgraph-mapping` runtime can load. `assemblyscript` is now a `@kasgraph/cli` dependency; the command drives it via the programmatic `asc.main()` API (works from any cwd, no PATH/spawn coupling).
- Flow: parse `subgraph.yaml` → map each `handlers[].handler` to its `mapping.file` → generate `build/entry.ts` that supplies `kasgraph_alloc` (bump allocator over the `--runtime stub` heap) and re-exports each handler under the runtime's lookup name → `asc` with `--optimize --runtime stub --use abort=` → write `build/<name>.wasm`.
- `--use abort=` is load-bearing: AssemblyScript otherwise emits an `env.abort` import the runtime linker doesn't define, which would fail instantiation. Dropping it makes an aborting handler trap instead (classified as `HandlerTrap` by the runtime).
- **ABI verification gate** (post-compile, via Node `WebAssembly.Module.exports/imports`): the wasm must export `memory` + `kasgraph_alloc` + every manifest handler, and must import nothing outside `kasgraph.{log,store_set}`. A mapping that compiles but violates the contract is rejected. Exit codes: 66 missing manifest/mapping, 65 parse/compile/ABI-violation, 69 missing toolchain.
- Tests: `tests/cli-build.test.ts` (8) compiles a real AS fixture and asserts the export/import shape, plus missing-manifest / missing-mapping / no-handlers / compile-error / missing-handler-export / stray-host-import paths. Total: 111 cargo + 166 TS = **277 tests** green; typecheck clean.
- **Known gap / next slice:** the six `examples/` mappings are async TS pseudo-code (Promise, `await`, closures) — AssemblyScript can't compile them. Porting them needs an AS authoring surface: a JSON decode for the `{block,payload}` event the host writes at `(ptr,len)`, and an entity-store API that serializes `EntityOp`s through `kasgraph.store_set`. That's what closes the loop to a real dispatchable subgraph.

## Previous commit arc (2026-05-28 — spend envelope on CovenantSpent payloads)

- `kasgraph codegen` now distinguishes spend semantics from lock-time state. On `covenant_id` sources, a `CovenantSpent` handler's payload becomes `{ spend: CovenantSpend; state: <stateType> }`, while `CovenantLocked` keeps the plain detector-state union (or `unknown` for unregistered families).
- The `CovenantSpend` interface is emitted **once** per events.ts and carries only protocol-observable, registry-independent fields: `operation: string`, `spentValueSompi: string`, `successorCovenantId: string | null`. These come from the spend tx + KIP-20 lineage tracker (Phase 2.4), so they're honest regardless of whether the locked covenant's detector pattern is registered (e.g. zk-proofs gets `{ spend: CovenantSpend; state: unknown }`).
- Subgraph-specific quantities the example mappings reference (amount, minted/burned deltas, new controller balance) stay **derived by the mapping** — they are not invented onto the typed payload. The krc20 example pseudo-code now reads `event.payload.spend.operation` / `event.payload.spend.successorCovenantId` and derives amounts via helpers.
- Tests: cli-codegen +1 ("attaches the spend envelope only to CovenantSpent, not CovenantLocked") → 15 cases; examples suite krc20 + zk-proofs assert the `CovenantSpend` interface and wrapped payload. Total: 111 cargo + 158 TS = **269 tests** green; typecheck clean. Commit `3e32ca5`.
- **Next slice:** the `kasgraph build` command — compile an AssemblyScript mapping (targeting the Phase 2.6 host/guest ABI) to a `.wasm` the runtime can load, which unblocks `deploy`/`status`/`logs`/`remove` and real subgraph execution.

## Previous commit arc (2026-05-28 — Phase 2.6 WASM mapping runtime on wasmtime)

- `kasgraph-mapping` goes from a no-op stub to a working sandboxed runtime. **wasmtime is the chosen host engine** (Bytecode Alliance flagship), picked for its determinism controls. This closes the long-standing "next big framework decision".
- Engine `Config` determinism lockdown: `consume_fuel(true)` (bounded execution — a runaway handler trips `Trap::OutOfFuel` rather than stalling the indexer), `cranelift_nan_canonicalization(true)` (bit-identical floats across machines), `wasm_threads(false)`, `wasm_relaxed_simd(false)`. Each `dispatch()` runs in a fresh `Store`, so handlers can't smuggle state across blocks.
- **Host/guest ABI** (also drives the future `kasgraph build` AssemblyScript target): guest exports `memory`, `kasgraph_alloc(i32)->i32`, and one `handler(ptr,len)` per manifest handler; guest imports `kasgraph.log(level,ptr,len)` + `kasgraph.store_set(ptr,len)`. The host writes event JSON (`{block:{daaScore,hash},payload}`) into guest memory via `kasgraph_alloc`, calls the handler, and collects emitted `MappingLog`s + `EntityOp`s into `DispatchOutcome`.
- `dispatch()` classifies failures precisely: `OutOfFuel`→`FuelExhausted{handler}`, malformed `store_set` JSON→`DecodePayload`, missing/mistyped exports→`AbiMismatch`, anything else→`HandlerTrap{handler,message}`. `from_wasm()` validates required exports up front and parses both `.wasm` and `.wat`.
- Tests: 10 unit tests on hand-written WAT fixtures — entity-op capture, leveled-log capture, handler trap, infinite-loop fuel exhaustion, malformed-op decode error, missing-handler/missing-memory/missing-alloc ABI mismatches, cross-run determinism, per-dispatch store isolation. No AssemblyScript toolchain needed at this layer. Total: 111 cargo + 157 TS = **268 tests** green; `cargo fmt` clean, zero warnings.
- **Next slice:** spend-semantic payload codegen (STATUS item 7), then the `kasgraph build` command that compiles an AssemblyScript mapping (targeting the ABI above) to a `.wasm` this runtime can load — which in turn unblocks `deploy`/`status`/`logs`/`remove` and real subgraph execution.

## Latest commit arc (2026-05-28 — per-detector payload codegen)

- `kasgraph codegen` now types handler payloads instead of emitting `payload: unknown` everywhere. Consumes the detector schema landed in the previous commit.
- New `cli/src/detector-schema.ts` — committed mirror of the Rust registry (kind + field names + byte widths), generated by `cli/scripts/gen-detector-schema.mjs` from `dump-registry` JSON. Kept as a committed artifact so the published CLI has no cargo dependency at codegen time; the gen script reproduces it byte-for-byte and codegen tests pin specific detector shapes to catch drift.
- `codegen.ts` event renderer: for each dataSource, reads `source.ids[].pattern` selectors; every selector that resolves in the schema emits a `<Kind>State` interface (covenant-state fields, all hex `string`, plus a `detectorKind` literal discriminator). A handler's `payload` becomes the union of its data source's detector states. Event interfaces are now deduped by event name (union'd across data sources) instead of one-per-handler, so shared event names can't produce duplicate declarations.
- Pattern-less sources (krc721 `collection`, utxo `addresses`) and unregistered selectors (ZK-aware family, not yet in the registry) keep `payload: unknown` — verified against the Phase 6 examples: krc20 → union of 5 KCC20 states, opensilver-patterns → union of 12, kasbonds → 2, krc721 / network-stats / zk-proofs → `unknown`.
- Tests: +2 cli-codegen cases (typed union from registered patterns; unknown for unregistered + pattern-less), plus payload assertions added to the examples suite. Total: 101 cargo + 157 TS = **258 tests** green. Typecheck clean.
- **Known gap (next slice):** the typed payload covers lock-time covenant *state* only. Spend-semantic fields the example mappings reference (`operation`, `amount`, `newControllerCovenantId`, `toPubkey`, …) are not registry fields; they need the mapping-runtime ABI to define the spend payload shape. That ABI is part of the **Phase 2.6 WASM mapping runtime** — the next big framework decision (AssemblyScript→WASM per PLAN; host-engine fork wasmtime vs wasmer), which also gates the remaining Phase-4 CLI commands and real deployment. That decision needs user input before starting.

## Previous commit arc (2026-05-28 — detector registry JSON export bridge)

- `kasgraph-detectors` now exposes the live registry as a machine-readable schema, the bridge that unblocks per-detector payload codegen on the TS side.
- New `registry_schema() -> RegistrySchema` walks `registry::all()` and emits `{ version, detectors: [{ kind, fields: [{ name, byte_len }] }] }`. Field names + byte widths come straight from each fingerprint's `masked_windows`. (Reminder: at runtime `payload_to_json` hex-encodes every field, so every field maps to a `string` in TS regardless of `byte_len`.)
- New `src/bin/dump-registry.rs`: `cargo run -p kasgraph-detectors --bin dump-registry > detector-schema.json`. Pretty-prints the schema to stdout. Kept as an on-demand exporter, not a committed artifact, so it can't drift.
- 3 new unit tests: schema covers every registered detector (count + non-empty + version + non-empty field names + positive widths); `OpenSilverMultisig` field shape pinned (`signer_pubkeys`/96, `threshold`/1); JSON round-trip. Detectors crate: 17 → 20 tests.
- Total: 101 cargo + 155 TS = **256 tests** green. `cargo build --workspace --all-targets` clean (the new bin compiles).
- **Next (the last self-contained slice before WASM):** wire `@kasgraph/cli` codegen to consume the `dump-registry` JSON and generate a typed payload interface per `pattern:` selector in a manifest, replacing `payload: unknown`. Every field → `string` (hex). Then the Phase 6 example mappings can drop their pseudo-code and decode typed payloads. After that, the big fork is the **Phase 2.6 WASM mapping runtime** — needs a user decision (wasmtime vs. wasmer vs. embedded JS), which gates the remaining Phase-4 CLI commands (`build`/`deploy`/`status`/`logs`/`remove`) and real subgraph deployment.

## Previous commit arc (2026-05-28 — Phase 6 complete: krc721 + network-stats + zk-proofs)

- `examples/` now ships **all six** reference subgraphs. Phase 6 is complete: 6.1 kasbonds ✓, 6.2 opensilver-patterns ✓, 6.3 krc20 ✓, 6.4 krc721 ✓, 6.5 network-stats ✓, 6.6 zk-proofs ✓.
- **`examples/krc721/`** (Phase 6.4) — native covenant-era NFTs via `kind: krc721` with a `collection: "*"` firehose. Entities: `KRC721Collection` / `KRC721Token` / `KRC721Holder` / `KRC721Mint` / `KRC721Transfer`. NFT-semantic handlers (`handleCollectionDeployed` / `handleNftMinted` / `handleNftTransferred` / `handleNftBurned`) abstract the underlying collection + per-NFT covenant lineage per `docs/references/KRC20_KRC721_REFERENCE.md`. README flags the native spec as still firming up (krc721.stream maintainers canonical).
- **`examples/network-stats/`** (Phase 6.5) — chain-wide aggregates via `kind: utxo` with `addresses: ["*"]` (the firehose). Entities: `BlockStat` (per-block production + tx/fee totals), `DailyStat` (per-UTC-day rollup), `AddressActivity` (per-address lifetime counters). Handlers `handleBlockAdded` (block production from the block stream) + `handleUtxoChanged` (tx volume / fees / address activity from the firehose). Chosen `utxo` because there is no block-level data-source kind; block-production counters ride the block stream the indexer already consumes.
- **`examples/zk-proofs/`** (Phase 6.6, KIP-16) — Groth16 proofs in covenant spends via `kind: covenant_id`. Entities: `ZkVerifyingKey` (registered at covenant lock) / `ZkProof` / `ZkWitness` (blob in object storage, row holds URI + sha256 per Phase 2.7 storage split) / `ZkVerification` (verify outcome recorded at index time). Handlers `handleVerifyingKeyRegistered` (CovenantLocked) + `handleProvenSpend` (CovenantSpent). Pattern selectors `ZkVerifierGroth16` / `ZkRollupCommit` / `ZkPrivateTransfer` are committed names; their detector-registry entries land when OpenSilver exports the ZK-aware pattern family (same pending posture as the placeholder fingerprint bytes).
- `tests/examples.test.ts` `it.each` extended from 3 → 6 examples; each new subgraph gets per-example entity + event-interface assertions. The generic registry/manifest/kind/handler-match checks already covered the new dirs automatically (they iterate `examples/`).
- Total: 98 cargo + 155 TS = **253 tests** green. Typecheck clean across all four TS packages. No Rust touched.
- Next: Phase 6 is done; the remaining Phase-4 CLI commands (`build` / `deploy` / `status` / `logs` / `remove`) and any real deployment of these subgraphs both gate on the **Phase 2.6 WASM mapping runtime** — the next big framework decision — and Phase 5 hosted infra.

## Previous commit arc (2026-05-28 — Phase 6 reference subgraphs)

- `examples/` was empty; now ships three reference subgraphs that double as integration smoke tests for the CLI pipeline.
- **`examples/kasbonds/`** (Phase 6.1) — first dogfooding customer; Bond / Holding / Coupon entities; `OpenSilverVault` + `OpenSilverEscrowMilestone` pattern source; `handleBondIssued` + `handleBondTransition` handlers with documented pseudo-code for the full impl.
- **`examples/opensilver-patterns/`** (Phase 6.2) — every detector kind in `crates/kasgraph-detectors/src/registry.rs` as a `pattern:` selector; generic `PatternInstance` + specialised projections for Vault / Multisig / Escrow.
- **`examples/krc20/`** (Phase 6.3, native KCC20) — replaces Kasplex for the post-Toccata era; KCC20Asset + KCC20Controller (with controllerKind discriminator) + KCC20Holder + KCC20Transfer + KCC20Mint entities; one handler each for asset/controller deployment and asset transitions covering transfer/mint/burn/rotate-controller.
- Every example follows the same layout: `subgraph.yaml` + `schema.graphql` + `src/mapping.ts` + `README.md`.
- `tests/examples.test.ts` adds 7 vitest cases that double as CLI integration tests:
    - Registry shape: every example dir has the four expected files.
    - Manifest shape: every subgraph.yaml parses + carries the right top-level fields + uses only documented dataSource kinds.
    - `it.each(['kasbonds', 'opensilver-patterns', 'krc20'])` runs `runCodegen` against the example dir and asserts the produced entities + events have the expected interfaces.
    - Cross-cutting check: every `handler.event` name in every manifest gets a matching `${event}Event` interface in the generated `events.ts`.
- `.gitignore` adds `examples/**/src/generated/` so the regenerated files don't pollute commits.
- Total: 98 cargo + 152 TS = **250 tests** green. Typecheck clean across all four TS packages.
- Phase 6 status: 3 of 6 reference subgraphs landed (6.1 KasBonds ✓, 6.2 OpenSilver Patterns ✓, 6.3 KRC-20 ✓). 6.4 KRC-721, 6.5 Network Stats, 6.6 ZK Proofs queue up the same template — each is a clean ~60-line slice once their data-source schemas firm up.

## Previous commit arc (2026-05-28 — kasgraph-api binary auto-wires LISTEN subscriptions)

- `kasgraph-api` operator binary now autoconfigures GraphQL subscriptions from env. A container with just `DATABASE_URL` set serves Query, healthz, AND live `Subscription.detectedPatterns` over SSE — no extra wiring.
- `RunServerOptions` gains `subscriptionsEnabled` + `listenDatabaseUrl`. `readOptionsFromEnv`:
    - `KASGRAPH_SUBSCRIPTIONS_ENABLED` (default `true`; flip to `false` to disable cleanly)
    - `LISTEN_DATABASE_URL` (default falls back to `DATABASE_URL`; override for a read replica or a different role with NOTIFY privileges)
- `runKasGraphServer` builds a `PgListenSource` with a `connect` factory returning a fresh `pg.Client` each lazy-reconnect; passes it to `createKasGraphServer` via conditional spread (honors `exactOptionalPropertyTypes:true`); `shutdown()` calls `source.close()` before ending the pool.
- `PgListenSource.onError` routed through the same structured JSON-line logger as the rest of the binary, prefixed with `PgListenSource:` for grep-ability.
- `tests/main.test.ts` adds 4 new vitest cases: defaults assert `subscriptionsEnabled=true` + `listenDatabaseUrl=DATABASE_URL`; `KASGRAPH_SUBSCRIPTIONS_ENABLED=false` disables; every standard truthy value (`1/true/TRUE/True/yes`) enables; `LISTEN_DATABASE_URL` falls back + overrides.
- Total: 98 cargo + 145 TS = **243 tests** green. Typecheck clean across all four TS packages.
- Phase 3.4 status: in-process source ✓, Postgres LISTEN/NOTIFY source ✓, schema + Yoga wiring ✓, operator binary auto-wiring ✓. The gateway can now stream every detector hit the indexer writes — no app-side `pg_notify` call, no extra setup beyond `DATABASE_URL`. Live SSE: hit a `Subscription` against `GET /graphql?query=subscription{...}` with `Accept: text/event-stream` and events stream as Postgres notifications arrive.

## Previous commit arc (2026-05-28 — Pg LISTEN/NOTIFY subscription source)

- Closes the indexer → gateway live loop without in-process StreamHub coupling.
- New migration `20260528120000_detector_hits_notify.sql` adds `kasgraph_notify_detected_pattern()` PL/pgSQL function + `AFTER INSERT` trigger on `kasgraph_detected_pattern`. Payload is `json_build_object(...)` matching the GraphQL `DetectedPattern` shape with BIGINT serialized as text to avoid JS Number precision loss. Any writer to the table participates — Rust indexer today, manual SQL, future writers — no app-side `pg_notify` call needed. Migrator test bumped to 4 migrations.
- `api/src/pg-listen.ts`: `PgListenSource implements SubscriptionSource` built around a minimal `PgListenClient` interface (`connect/query/on/removeAllListeners/end`) so tests mock the client and production wires `new pg.Client(connectionString)`. Lazy-connect on first subscribe (LISTEN once, fan out via internal `InMemorySubscriptionSource`), UNLISTEN + `end()` when the last subscriber drops, lazy-reconnect when a new subscriber arrives after `close()`.
- Payload normaliser: requires `subgraph` / `blockHash` / `blockDaaScore` / `txHash` / `outputIndex` / `detectorKind` (rejects malformed payloads silently rather than emitting half-shaped events). Optional `covenantId` / `payload` omitted from the response when null. BIGINT delivered as either string or number is coerced to string.
- `tests/pg-listen.test.ts` adds 12 vitest cases using a `FakeListenClient` recording every call + holding the registered notification listener: lazy LISTEN on first subscribe; multiple subscribers share one LISTEN; UNLISTEN + end on last drop; payload routing in order; optional-field omission; required-field-missing dropped; empty-payload notification dropped; wrong-channel notification dropped; malformed JSON dropped via `onError`; subscriber stays usable after the malformed payload; `close()` UNLISTENs even with active subscribers; lazy-reconnect after close.
- Total: 98 cargo + 141 TS = **239 tests** green. Typecheck clean across all four TS packages.
- Phase 3.4 status: in-process source ✓, Postgres LISTEN/NOTIFY source ✓, schema + Yoga wiring ✓. The gateway can now stream every detector hit the indexer writes — no in-process coupling, no polling, no NOTIFY call on the Rust side. Wiring `PgListenSource` into the operator binary (so `kasgraph-api` autoconfigures subscriptions when a `LISTEN_DATABASE_URL` is set) is the next jump for that phase.

## Previous commit arc (2026-05-28 — GraphQL Subscription wiring)

- `@kasgraph/api` now ships a `Subscription` type + a pluggable `SubscriptionSource` contract. The gateway becomes the first end-to-end consumer of the Phase 3.4 "live event" model.
- `KASGRAPH_BASE_SCHEMA_SDL` gains `type Subscription { detectedPatterns(subgraph, kind, covenantId): DetectedPattern! }` with all three args optional + AND-combined.
- `api/src/subscriptions.ts`: `SubscriptionSource` interface (`subscribeDetectedPatterns(filter) → AsyncIterable<DetectedPattern>`) + `InMemorySubscriptionSource` (process-local pub/sub on top of a custom AsyncIterable; back-pressure via an unbounded queue per subscriber; cleanly drops the subscriber on iterator `return()`). `matches(event, filter)` exported so a future PgListenSource reuses the same filter semantics.
- `createKasGraphServer` switches schema construction from `buildSchema` + rootValue (which couldn't express subscriptions) to graphql-yoga's `createSchema` with field resolvers for `Query.*` + a `subscribe`/`resolve` resolver for `Subscription.detectedPatterns`. `executeGraphQLQuery` keeps using `getKasGraphSchema()` + rootValue for the in-process Query-only path.
- Subscription field rejects every subscribe with a clear "subscriptions are not configured" error when `subscriptionSource` is omitted — clients see a cause instead of a silent hang.
- Yoga ships SSE for subscriptions out of the box; WebSocket transport can layer on with `graphql-ws` in a later slice.
- `tests/subscriptions.test.ts` adds 11 vitest cases: filter semantics across every key + AND combinations + "hit without covenantId vs filter with covenantId"; InMemory ordering, await-before-publish, iterator-return drops subscriber, pending-iterator-resolves-done-on-return, fan-out delivery; schema introspection round-trip confirms Subscription appears; subscribing without a source surfaces the expected error.
- Total: 98 cargo + 129 TS = **227 tests** green. Typecheck clean across all four TS packages.
- Phase 3.4 status: in-process subscription path complete. Next slice: a `PgListenSource` that LISTENs on a `kasgraph_detected_pattern` channel (paired with a tiny `NOTIFY` trigger or app-side `pg_notify` call from `kasgraph-node`) so the gateway streams hits the indexer writes — closing the loop without an in-process StreamHub coupling.

## Previous commit arc (2026-05-28 — kasgraph CLI `codegen`)

- `kasgraph codegen` is live. Reads `./subgraph.yaml` + `./schema.graphql` from the subgraph directory and writes `src/generated/{entities,events}.ts`.
- Entity rendering walks every non-root `ObjectTypeDefinition` in the SDL; maps GraphQL scalars to TypeScript (`String`/`ID` → `string`, `Int`/`Float` → `number`, `Boolean` → `boolean`, `BigInt` → `bigint`, `Bytes` → hex `string`, `JSON` → `unknown`); preserves non-null vs optional (nullable becomes `?: T`); renders lists as `Array<T>` with inner nullability collapsing to `T | null`; object-type references stay as the referenced interface name (foreign-key style).
- Event rendering walks every handler across every dataSource in the manifest and emits one interface per handler with a fixed envelope: `event` literal, `block { hash, daaScore (bigint), blueScore (bigint) }`, `tx { hash, index }`, and `payload: unknown` (per-detector payload codegen lands in a later slice).
- Exit codes follow EX_ conventions: 66 (`EX_NOINPUT`) when `subgraph.yaml` or `schema.graphql` is missing; 65 (`EX_DATAERR`) on parse failure; 0 on success with a summary line.
- The `init` → `codegen` flow now closes cleanly: the init template's `mapping.ts` imports `./generated/events.js` and codegen produces exactly that file with `CovenantLockedEvent` + `CovenantSpentEvent` matching the scaffolded handler names.
- `tests/cli-codegen.test.ts` adds 12 vitest cases against tmp-dir fixtures: missing-input errors, malformed SDL error, every scalar mapping, list inner-nullability, object-type references, Query/Mutation skipping, multi-dataSource event rendering, no-handlers empty body, full init+codegen end-to-end, `runCommand("codegen")` path, regeneration over stale generated files.
- `cli/package.json` gains `graphql ^16.10.0` + `yaml ^2.6.0`. Typecheck clean across all four TS packages.
- Total: 98 cargo + 118 TS = **216 tests** green.
- Phase 4 CLI status: `init` ✓, `codegen` ✓, `mcp-config` ✓. `build` / `deploy` / `status` / `logs` / `remove` still wait on the Phase 2.6 WASM mapping runtime (the next big framework decision).

## Previous commit arc (2026-05-28 — kasgraph CLI `init` + `mcp-config`)

- `@kasgraph/cli` goes from a dispatch shim to a real CLI. New `runCommand(argv, io)` returns a numeric exit code and routes to per-command bodies.
- `kasgraph init <name>` scaffolds a working subgraph dir: `subgraph.yaml` (matching the `SubgraphManifest` shape from `@kasgraph/sdk`), `schema.graphql` (KasBonds-style placeholder), `src/mapping.ts` (handler stubs), `package.json`, `.gitignore`, `README.md`. Validates the name against `^[a-z0-9][a-z0-9_-]{0,63}$`. Refuses to clobber an existing directory.
- `kasgraph mcp-config` prints a Claude Desktop / Cursor / OpenClaw `mcpServers` JSON snippet wiring `kasgraph-mcp` over stdio. Flags: `--database-url`, `--command`, `--server-name`.
- Commands recognized but not yet implemented (`codegen`, `build`, `deploy`, `status`, `logs`, `remove`) surface a clear "not implemented yet (Phase 4 WASM pipeline pending)" message and exit 64.
- `cli/src/cli.ts` is now a thin shim wiring `process.argv/env/stdout/stderr` into `runCommand`; everything else lives in modules that tests exercise without spawning a child process.
- `tests/cli.test.ts` adds 18 vitest cases against a `CapturedIo` + per-test tmpdir: dispatch shape, init validation (missing name / bad regex / clobber refusal), scaffolded-file assertions (subgraph.yaml + package.json shape, placeholder schema entity), mcp-config flag parsing, JSON shape, and an end-to-end runCommand path for both subcommands.
- Total: 98 cargo + 106 TS = **204 tests** green. Typecheck clean across all four TS packages.
- Phase 4 (developer CLI) now has its two no-WASM-required commands live. `codegen` + `build` + `deploy` wait on the WASM mapping runtime (Phase 2.6 — the next big framework decision).

## Previous commit arc (2026-05-28 — kasgraph-mcp operator binary on stdio)

- `@kasgraph/mcp` now ships a real MCP server + operator binary (`bin: { kasgraph-mcp: dist/main.js }`) over the canonical `@modelcontextprotocol/sdk` Server with `StdioServerTransport`.
- `mcp/src/server.ts`: `createKasGraphMcpServer(handlers)` registers `ListToolsRequestSchema` (returns `mcpToolListing()` in canonical order) and `CallToolRequestSchema` (routes through `dispatchMcpTool` → MCP text-content blocks). `runMcpStdioServer(handlers)` connects stdio.
- `callToolToContent(name, args, handlers)` factored out as the pure helper that wraps results (or structured errors with codes `unknown_tool` / `invalid_input` / `handler_error`) in the MCP `{content: [{type:'text', text: JSON}]}` shape. Pure-function design means vitest exercises it without a transport.
- `mcp/src/main.ts`: env-driven entry mirroring `kasgraph-api`. Reads `DATABASE_URL` (or `KASGRAPH_DATABASE_URL`), builds `pg.Pool` + `PgMcpHandlers`, connects to stdio, registers SIGINT/SIGTERM handlers that close transport + server + pool. Logs to **stderr** so stdout stays clean for the MCP protocol frames.
- `tests/mcp-main.test.ts` adds 10 vitest cases: server constructs without throwing; success/route paths produce one text content block; unknown tool / missing required field / handler-thrown-error each map to `isError:true` with the right structured code; env reader honors precedence + both env-var names.
- `@modelcontextprotocol/sdk ^1.0.0` and `pg ^8.13.0` added to `mcp/package.json` deps. Typecheck clean across all four TS packages.
- Total: 98 cargo + 90 TS = **188 tests** green.
- Phase 3.2 (MCP, CRITICAL per PLAN.md) is now operationally complete: typed contract → in-memory handlers → Postgres handlers → MCP server scaffolding → env-driven stdio binary. A container running `kasgraph-mcp` with just `DATABASE_URL` set is reachable from any MCP client (Claude Desktop, IDE plugins, custom LLM agents).

## Previous commit arc (2026-05-28 — kasgraph-api operator entry binary)

- `@kasgraph/api` now ships a real operator binary at `dist/main.js` (exposed via `bin: { kasgraph-api: ... }`). Reads `DATABASE_URL` / `KASGRAPH_DATABASE_URL` (required), `HOST` (default `0.0.0.0`), `PORT` (default `4000`), `GRAPHQL_ENDPOINT` (default `/graphql`), `GRAPHIQL` (default `true`).
- Splits cleanly so the routing + healthz logic is unit-testable without binding sockets:
    - `healthzResponse(pool)` → `{ status, body, contentType }` (200 on `SELECT 1` success; 503 with error message on throw)
    - `createKasGraphHttpHandler(yoga, healthCheck)` → Node `(req, res) => void`. Routes `GET/HEAD /healthz` to the health check, 405s anything else on that path, forwards everything else to Yoga.
    - `runKasGraphServer(options)` → starts http server, returns `{ address, shutdown() }`
    - `main()` → `readOptionsFromEnv` → `runKasGraphServer` → SIGINT/SIGTERM handlers that cleanly close the http server and end the pg pool
- Structured JSON-line logging to stdout (info/warn) and stderr (error) — operators can pipe through `jq` or redirect without parsing.
- `tests/main.test.ts` adds 13 vitest cases against actual Node http servers bound to port 0 + a `StubPool` and a recording sentinel Yoga handler. Covers: healthz 200/503 shape, GET/HEAD/POST routing, `/healthz?qs` matching, 405 on POST, non-healthz forwarding to Yoga, env defaults + overrides for every read knob, `KASGRAPH_DATABASE_URL` fallback, non-numeric PORT degradation.
- Total: 98 cargo + 80 TS = **178 tests** green. Typecheck clean across all four TS packages.
- Phase 3.1 (GraphQL gateway) is now operationally complete: typed contract → in-memory resolvers → Postgres resolvers → HTTP transport → env-driven binary with healthz and graceful shutdown. Hosted-service infra (Phase 5) can wrap this binary directly in a container.

## Previous commit arc (2026-05-28 — Yoga HTTP transport for the GraphQL gateway)

- `@kasgraph/api` now ships `createKasGraphServer({ pool, resolvers?, graphqlEndpoint?, graphiql? })` returning a Yoga handler (Fetch-API `(Request) => Response` function — slots into Node `http`, Workers, Deno, or `yoga.fetch` for tests).
- Schema construction stays in `getKasGraphSchema()` (rootValue-based); Yoga injects `rootValue` at execute time via a tiny `onExecute` plugin. The same schema definition + resolvers feed both `executeGraphQLQuery` (in-process) and the HTTP handler, so they cannot drift.
- Vitest config gained a `graphql` → `node_modules/graphql/index.js` alias plus `dedupe: ['graphql', 'graphql-yoga']`. Without this, vitest holds both CJS and ESM copies of `graphql` in the same process and Yoga errors with "Cannot use GraphQLSchema from another module or realm."
- `tests/server.test.ts` adds 7 vitest cases using `yoga.fetch` directly (no socket binding): GraphiQL HTML served on GET, POST query execution against in-memory resolvers, end-to-end POST through `PgGatewayResolvers` against the same `MockPool` pattern as `pg-handlers`/`pg-resolvers`, GraphQL-validation errors surface with the right body, `__schema` introspection round-trip, `graphiql:false` disables the UI, and `graphqlEndpoint` override routes the handler to a custom path.
- Tests honor the GraphQL-over-HTTP spec: `Accept: application/graphql-response+json, application/json` on POSTs; validation errors accepted as either 200 or 400 (Yoga returns 400 per spec when the spec-compliant Accept is sent).
- `graphql-yoga ^5.10.0` added to `api/package.json`.
- Total: 98 cargo + 67 TS = **165 tests** green. Typecheck clean across all four TS packages.
- Phase 3.1 (GraphQL gateway) is now end-to-end reachable: typed contract → in-memory resolvers → Postgres resolvers → HTTP transport. Next slice for that phase is the operator entry binary (read `DATABASE_URL` / `PORT` from env and start a Node `http` server wrapping the Yoga handler).

## Previous commit arc (2026-05-28 — Postgres-backed McpHandlers)

- `@kasgraph/mcp` now ships `PgMcpHandlers` implementing every `McpHandlers` method against the Phase 2.4 + 2.5 schema, mirroring `PgGatewayResolvers` from `@kasgraph/api`.
- Fully backed by Postgres: `list_subgraphs` (GROUP BY with optional `LOWER(subgraph) LIKE` filter), `search_by_pattern` (kind filter + bounded limit + ordered), `get_covenant_lineage` (head + ordered entries; returns empty lineage when head missing instead of throwing).
- `get_schema` returns the canonical `KASGRAPH_BASE_SCHEMA_SDL` for any subgraph id — per-subgraph SDL wires in when the codegen pipeline lands.
- `execute_query` delegates to `executeGraphQLQuery + PgGatewayResolvers` against the *same* pool so an MCP client and a GraphQL client see identical results for the same query.
- Three unbacked tools — `get_address_activity`, `find_subgraphs_for_address`, `query_natural_language` — throw `McpHandlerNotImplementedError` with a clear reason. `NOT_IMPLEMENTED_TOOLS` exported for `tools/list` consumers that want to surface a "coming soon" hint.
- `@kasgraph/api` added as a dep + tsconfig reference of `@kasgraph/mcp` so the gateway pieces (`PgPoolLike`, `executeGraphQLQuery`, `PgGatewayResolvers`, `KASGRAPH_BASE_SCHEMA_SDL`) are usable.
- 14 new vitest cases in `tests/pg-handlers.test.ts` pin: SQL shape per handler, parameter binding, keyword-LIKE lowercasing, limit clamping, head-missing branch, two-query lineage sequence, end-to-end GraphQL round-trip through the same mock pool, GraphQL parse errors flow through cleanly, each not-implemented tool throws the right error.
- Total: 98 cargo + 60 TS = **158 tests** green. Typecheck clean across all four TS packages.
- Phase 3.2 now has a real Postgres-backed production handler. The 5 fully-backed tools are production-ready; the 3 unbacked ones surface a clear error. Next slice for Phase 3.2: stdio/SSE transport via `@modelcontextprotocol/sdk` so the handlers are reachable from LLM clients.

## Previous commit arc (2026-05-26 — Postgres-backed GatewayResolvers)

- `@kasgraph/api` now ships `PgGatewayResolvers` implementing every `GatewayResolvers` method against the Phase 2.4 + 2.5 schema: `committedBlock`, `committedBlocks`, `poiCheckpoints` (with optional `fromDaa`/`toDaa` bounds), `detectedPatterns` (with optional `kind` filter), `covenantLineage` (head + ordered entries).
- Constructed against a minimal `PgPoolLike` interface — production code passes a real `pg.Pool`; tests use a recording mock that captures `(sql, values)` tuples and replays canned `rows[]`.
- Defensive serializers handle the cross-shape pg type-parser delivery: `bigIntString` for BIGINT (string OR number), `isoString` for TIMESTAMPTZ (Date OR string), `hexFromBytes` for BYTEA (Buffer / Uint8Array / string).
- `boundedFirst` clamps `first` to `[1, 1000]` with default 50; null `covenant_id` / `payload` columns get omitted from the response (honors `exactOptionalPropertyTypes: true`).
- 12 new vitest cases in `tests/pg-resolvers.test.ts` pin: SQL shape per resolver, parameter binding order, optional-clause inclusion, `first` clamping/defaulting, hex serialization across buffer/string/Uint8Array, lineage two-query sequence with empty-bytes omission.
- `pg ^8.13.0` + `@types/pg ^8.11.10` added to `api/package.json`. Typecheck clean across all four TS packages.
- Total: 98 cargo + 46 TS = **144 tests** green.
- Phase 3.1 now has a real Postgres-backed production resolver. Next slice for that phase: a Yoga HTTP server wrapping `executeGraphQLQuery` + `PgGatewayResolvers` so the gateway responds to real GraphQL requests end-to-end.

## Previous commit arc (2026-05-26 — GraphQL gateway surface + dispatch)

- `@kasgraph/api` now ships the canonical KasGraph base schema (`CommittedBlock`, `PoiCheckpoint`, `DetectedPattern`, `CovenantLineage`, `CovenantLineageEntry` plus `BigInt` + `JSON` scalars), an executable schema built lazily via `buildSchema`, a `GatewayResolvers` interface, and `executeGraphQLQuery(request, resolvers)` that uses the reference `graphql` engine for parse + validate + execute.
- `BigInt` scalar serializes DAA scores as decimal strings (no JS Number precision loss past 2^53). `JSON` scalar passes payloads through as-is.
- Framework choice (Apollo / Yoga / Mercurius per PLAN.md Phase 3.1) is intentionally NOT baked in. This module talks to `graphql/execute` directly; any framework can wrap it as an HTTP transport. Yoga is still the recommended default once Phase 3.4 WebSocket subscriptions land.
- `tests/api.test.ts` adds 13 vitest cases against an in-memory `InMemoryResolvers` impl with seeded subgraphs/lineage/hits: schema-surface assertions, introspection round-trip, parse/validation error shapes, every query routes correctly with optional-arg omission honored, JSON-scalar payload pass-through, BigInt-as-string serialization.
- `graphql ^16.10.0` added to `api/package.json` dependencies. `tsc --noEmit` clean across all four TS packages.
- Total: 98 cargo + 34 TS = **132 tests** green.
- Phase 3.1 (GraphQL gateway) goes from a 23-line config interface to a typed schema + resolver + dispatcher contract. Next slice: Postgres-backed `GatewayResolvers` impl talking to the Phase 2.4 schema, then a Yoga HTTP server wrapping it.

## Previous commit arc (2026-05-26 — MCP tool surface + dispatch contract)

- `@kasgraph/mcp` was a name-only enumeration; now declares per-tool `McpTool { name, description, inputSchema }` for all 8 tools with `additionalProperties:false` JSONSchema inputs.
- Per-tool TypeScript Input/Output types capture the wire shapes (e.g. `SubgraphSummary`, `CovenantLineageEntry`, `AddressActivityEntry`) so production handlers and test handlers share one contract.
- `McpHandlers` interface declares one method per tool. `dispatchMcpTool(name, args, handlers)` routes to the right method, validates required input keys, and throws `McpDispatchError { code: 'unknown_tool' | 'invalid_input' }` for malformed calls. Conditional spread keeps `exactOptionalPropertyTypes: true` happy.
- `tests/mcp.test.ts` adds an in-memory `McpHandlers` impl with seeded subgraphs/addresses and 16 vitest cases covering registry shape, unknown-tool rejection, missing-field rejection, every tool routing correctly, optional-field omission, and the calls-recorded invariant.
- Total: 98 cargo tests + 21 TS tests = 119 green; typecheck clean across all four TS packages.
- Phase 3.2 (MCP, CRITICAL per PLAN.md) goes from "tool names enumerated" to "typed dispatch contract + reference test handler". Next slice for that phase: a production handler backed by `pg` that queries the Phase 2.4 schema, plus a stdio/SSE transport.

## Previous commit arc (2026-05-26 — detector observability in continuous_wrpc_smoke)

- `continuous_wrpc_smoke` now dispatches `kasgraph_detectors::detect_in_output` against every output of every received `BlockAdded` / `VirtualChainChanged` block — same dispatch the indexer's `block_from_rpc` performs in production.
- Per-kind tally rolled into both the stdout summary line and the `KASGRAPH_WRPC_SUMMARY_JSON` artifact (`detectorHitsTotal`, `detectorHitsPerKind { kind: count, ... }`).
- Per-hit NDJSON event when `KASGRAPH_WRPC_EVENT_NDJSON` is set: `{kind: "detector_hit", block_hash, block_daa_score, tx_hash, output_index, detector_kind, covenant_id, payload, ts_ms}`.
- `kasgraph_detectors` added as a `[dev-dependencies]` entry on `kasgraph-rpc` (kept the production crate dep-free of detectors so the layering stays clean).
- The point of this slice: validate against real mainnet outputs that the placeholder `0xFE`-prefixed discriminators don't false-positive. A clean soak that reports `detector_hits_total=0` proves the placeholder bytes are safe to keep until real OpenSilver compiled bytes ship.
- 98 tests still green; build clean, zero warnings.

## Previous commit arc (2026-05-26 — detector hits published to KasStream hub)

- `kasgraph-node` creates a single `kasgraph_stream::StreamHub` at startup (capacity from `KASGRAPH_STREAM_CAPACITY`, default 1024).
- `apply_and_persist_notification` takes `Option<&StreamHub>`; after every successful detector-hit DB insert, the same hit is built into a `StreamEvent` and published via `publish_hit_to_stream`.
- Event payload nests the original `detector_payload` plus `tx_hash`, `output_index`, and (when present) `covenant_id` so the existing `StreamFilter::CovenantId(...)` matcher works on real published events without re-deriving the id from kind-specific payload schemas.
- Hub is threaded through to both the bootstrap and continuous paths (continuous-mode recovery re-applies also publish).
- Three new node-side tests pin: All-filter subscriber receives the published event with all expected fields; `None` hub is a clean no-op; `StreamFilter::CovenantId` correctly filters published events.
- Phase 3.3 (KasStream streaming primitive) now has both a hub implementation and a real producer wired into the node. The gRPC server layer on top is the next jump for that phase.
- 98 tests total (was 95). Build clean, zero warnings.

## Previous commit arc (2026-05-26 — detector hits persisted + POI now reflects them)

- New migration `20260526160000_detector_hits.sql` adds `kasgraph_detected_pattern (subgraph, block_hash, block_daa_score, tx_hash, output_index, detector_kind, covenant_id, payload, detected_at)`. Three indexes: subgraph+DAA-desc, subgraph+kind+DAA-desc, and a partial covenant-id index.
- `Store::insert_detected_pattern` uses `ON CONFLICT DO UPDATE` so re-applying a block (e.g. mid-recovery) is idempotent. `Store::unwind_committed_blocks_for_subgraph` now also deletes matching detector rows in the same transaction — the same chain bytes always produce the same detector ledger.
- `BootstrapBlock` gains `detector_hits: Vec<DetectedPattern>` computed once in `block_from_rpc`; production code reads it directly, tests still use the `#[cfg(test)]` `run_detectors_on_block` helper.
- `canonical_bytes_for_block` now incorporates sorted detector hits. Each row is rendered as `det:tx_hash:output_index:kind:covenant_id:canonical_payload_json`. Sort key is `(tx_hash, output_index, kind)`; payload JSON keys are sorted via `canonicalize_json` so the bytes are invariant under emission order *and* under serde's source-key order.
- POI now reflects real on-chain state, not just block metadata — the verifiability goal from Phase 2.8 is unblocked.
- Three new node tests pin: canonical bytes change when hits differ; canonical bytes stable under hit reordering; canonical bytes stable under payload key reordering. Store migrator test updated to expect 3 migrations.
- `DetectorKind` derive gained `PartialEq` (already had `Eq` via the discriminant-only Hash derive); `BootstrapBlock` / `IngestionState` / `IngestionTransition` shed `Eq` since `DetectedPattern.payload` is a `serde_json::Value`.
- 95 tests total (was 92). Build clean, zero warnings.

## Previous commit arc (2026-05-26 — detector pipeline now sees real outputs)

- `IngestedBlock` gains `outputs: Vec<IngestedTransactionOutput>`. Each entry carries `tx_hash`, `output_index`, hex-decoded `script_public_key`, and `value` (sompi). Serde-`default` keeps backwards compat with header-only notifications.
- `parse_block_value` now walks `transactions[].outputs[]` from the live wRPC payload, decoding `scriptPublicKey.scriptPublicKey` hex strings. Three new tests cover the happy path, the no-`transactions` case, and the skip-malformed-entries case while preserving `output_index` alignment.
- `BootstrapBlock` carries the outputs through to the persist path. The continuous-mode commit loop now calls `kasgraph_detectors::detect_in_output` over every output of each committed block via `run_detectors_on_block` and logs a per-kind summary (`Vault:3,KCC20Asset:1`).
- Phase 2.5 finally has a real consumer: the detector registry is now exercised on live wRPC traffic, not just in unit tests. Once OpenSilver ships real compiled-script bytes the placeholder discriminators get replaced and live mainnet patterns will surface in node logs immediately.
- Three new node-side tests for `run_detectors_on_block` (empty-outputs case, registry-match case, mixed match/non-match) plus a focused `summarize_detector_hits` test.
- 92 tests total (was 86). Build clean, zero warnings.

## Previous commit arc (2026-05-26 — combined integration test for reconnect + gap)

- New `continuous_subscription_interleaves_events_and_notifications_around_reconnect_gap` test asserts the notification stream AND the driver-event stream agree on ordering around a reconnect-with-gap.
- Notification stream: `BlockAdded(10)`, `BlockAdded(11)`, synthetic `RecoveryRequired(12, 14, ...)`, `BlockAdded(15)`.
- Event stream: `Connected(0)`, `ReconnectScheduled(1, ...)`, `Connected(1)`, `GapDetected(1, 12, 14)`.
- Same `reconnect_count` threaded through both streams; same DAA range in synthetic recovery and `GapDetected` event. This is the exact shape the soak runner now persists in NDJSON, so the trace artifact is now grounded by an in-process integration assertion.
- 86 tests total. Build clean, zero warnings.

## Previous commit arc (2026-05-26 — NDJSON event trace from the soak runner)

- `continuous_wrpc_smoke.rs` now accepts `KASGRAPH_WRPC_EVENT_NDJSON=<path>`. When set, every driver event (`Connected`, `ReconnectScheduled`, `GapDetected`, `Stopped`) and every notification (`BlockAdded`, `VirtualChainChanged`, `RecoveryRequired`) is appended as a JSON object with a `ts_ms` unix-millisecond timestamp.
- Output uses `BufWriter<File>` and is flushed + closed cleanly on shutdown. Path parent dirs are created on the fly.
- Designed as a replayable trace artifact for diffing soak runs and feeding into the next jump: a targeted integration test that exercises the rpc driver against a mock ws server simulating reconnect + stale-replay + overlap and asserts on the resulting NDJSON.
- 85 tests still green; build has zero warnings.

## Earlier live validation (2026-05-26 — first 15-minute soak stayed clean)

- Ran:
  - `KASGRAPH_WRPC_DURATION_SECONDS=900 KASGRAPH_WRPC_MAX_MESSAGES=0 KASGRAPH_WRPC_SUMMARY_JSON=/tmp/kasgraph-wrpc-soak-900s.json cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- Observed real soak result against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 5597 notifications in 900 seconds
  - `blocks=2800`
  - `virtual_chain_changed=2797`
  - `recovery_required=0`
  - `highest_daa_seen=444267105`
  - `reconnects=0`
  - `connections=1`
  - JSON artifact written successfully to `/tmp/kasgraph-wrpc-soak-900s.json`
- This is the first longer live baseline showing the current driver stayed connected cleanly for 15 minutes with no synthetic recovery requests.

## Previous live validation (2026-05-26 — first 5-minute soak stayed clean)

- Ran:
  - `KASGRAPH_WRPC_DURATION_SECONDS=300 KASGRAPH_WRPC_MAX_MESSAGES=0 KASGRAPH_WRPC_SUMMARY_JSON=/tmp/kasgraph-wrpc-soak-300s.json cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- Observed real soak result against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 2177 notifications in 301 seconds
  - `blocks=1087`
  - `virtual_chain_changed=1090`
  - `recovery_required=0`
  - `highest_daa_seen=444258625`
  - `reconnects=0`
  - `connections=1`
  - JSON artifact written successfully to `/tmp/kasgraph-wrpc-soak-300s.json`
- This is the first medium-duration baseline showing the current driver stayed connected cleanly for five minutes with no synthetic recovery requests.

## Previous live validation (2026-05-26 — first 60-second soak stayed clean)

- Ran:
  - `KASGRAPH_WRPC_DURATION_SECONDS=60 KASGRAPH_WRPC_MAX_MESSAGES=0 KASGRAPH_WRPC_SUMMARY_JSON=/tmp/kasgraph-wrpc-soak-60s.json cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- Observed real soak result against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 465 notifications in 60 seconds
  - `blocks=233`
  - `virtual_chain_changed=232`
  - `recovery_required=0`
  - `highest_daa_seen=444252802`
  - `reconnects=0`
  - `connections=1`
  - JSON artifact written successfully to `/tmp/kasgraph-wrpc-soak-60s.json`
- This is the first longer-duration baseline showing the current driver stayed connected cleanly for a full minute with no synthetic recovery requests.

## Previous commit arc (2026-05-26 — continuous soak runner now writes JSON summaries)

- `crates/kasgraph-rpc/examples/continuous_wrpc_smoke.rs` now supports `KASGRAPH_WRPC_SUMMARY_JSON=<path>` and writes a structured JSON artifact containing:
  - counts by notification type
  - `highestDaaSeen`
  - reconnect / connection counts
  - stop reason
  - observed gap ranges
  - advertised capability bits
- Verified live with:
  - `KASGRAPH_WRPC_DURATION_SECONDS=10 KASGRAPH_WRPC_MAX_MESSAGES=0 KASGRAPH_WRPC_SUMMARY_JSON=/tmp/kasgraph-wrpc-soak-summary.json cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- Observed real soak result against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 106 notifications in 10 seconds
  - `highest_daa_seen=444251243`
  - `reconnects=0`
  - `connections=1`
  - JSON artifact written successfully to `/tmp/kasgraph-wrpc-soak-summary.json`
- Verification after the change:
  - `cargo fmt && cargo test -p kasgraph-rpc`
  - full `cargo test`
- This gives the next session a reusable artifact format for comparing 1m / 5m / 15m live soaks.

## Previous commit arc (2026-05-26 — continuous soak runner now emits reconnect/high-water summaries)

- `kasgraph-rpc` now exposes `SubscriptionDriverEvent` plus `spawn_continuous_subscription_with_events(...)` so long-lived smoke/integration flows can observe:
  - connect events
  - reconnect scheduling
  - synthetic gap detection
  - driver stop reasons
- `crates/kasgraph-rpc/examples/continuous_wrpc_smoke.rs` now supports wall-clock soak runs with:
  - `KASGRAPH_WRPC_DURATION_SECONDS`
  - optional `KASGRAPH_WRPC_MAX_MESSAGES=0` for duration-only stop
  - compact summary output including `highest_daa_seen`, reconnect count, connection count, and stop reason
- Added regression coverage:
  - `continuous_subscription_emits_driver_events_for_reconnects`
- Verified live with:
  - `KASGRAPH_WRPC_DURATION_SECONDS=10 KASGRAPH_WRPC_MAX_MESSAGES=0 cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- Observed real soak result against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 100 notifications in 10 seconds
  - `highest_daa_seen=444248915`
  - `reconnects=0`
  - `connections=1`
- Verification after the change:
  - `cargo fmt && cargo test -p kasgraph-rpc`
  - full `cargo test`
- This gives the next session a much better baseline for longer live-node soak comparisons.

## Previous commit arc (2026-05-26 — reconnect gap detection hardened against stale replay / overlap)

- Fixed a real continuous-driver edge case in `kasgraph-rpc`: after reconnect, stale replay at or below the previous DAA watermark no longer clears the pending gap check.
- Gap detection now waits for the first **actually new** DAA above the prior watermark, which also fixes overlapping `VirtualChainChanged` reconnect payloads where the notification includes both old and new DAA scores.
- Added regression tests:
  - `continuous_subscription_keeps_gap_check_pending_across_stale_replay_after_reconnect`
  - `continuous_subscription_detects_gap_when_virtual_chain_delta_overlaps_old_daa`
- Verification after the change:
  - `cargo fmt && cargo test -p kasgraph-rpc`
  - full `cargo test`
- This is a meaningful Phase 2.3 hardening step: reconnects shaped like replay + jump no longer silently suppress synthetic recovery.

## Previous commit arc (2026-05-26 — continuous smoke example landed on top of the `wss://` hardening)

- Added `crates/kasgraph-rpc/examples/continuous_wrpc_smoke.rs`, which exercises the same `spawn_continuous_subscription(...)` reconnect-capable driver used by the node, but without requiring Postgres.
- Verified it live with:
  - `KASGRAPH_WRPC_MAX_MESSAGES=6 cargo run -p kasgraph-rpc --example continuous_wrpc_smoke`
- That continuous smoke captured a mixed real stream from `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`:
  - 5 `BlockAdded`
  - 1 `VirtualChainChanged`
  - 0 `RecoveryRequired`
- This is important because it proves the in-tree continuous driver can hold a real public mainnet stream end-to-end now that TLS/provider setup is correct.
- README / STATUS / NEXT_SESSION / RPC reference were updated again to point the next agent at the new smoke path and the remaining reconnect/recovery goals.

## Previous commit arc (2026-05-26 — live smoke example + real `wss://` path hardened)

- Added `crates/kasgraph-rpc/examples/live_wrpc_smoke.rs` for repeatable public-node validation without ad hoc scripts.
- The repo now explicitly installs a rustls crypto provider before websocket connects, which fixed a real runtime blocker: `wss://` had previously failed with `TLS support not compiled in` and then with rustls `CryptoProvider` panics.
- `cargo run -p kasgraph-rpc --example live_wrpc_smoke` now works against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json` from this environment.
- That live smoke captured real notifications from mainnet, including both:
  - `BlockAdded`
  - `VirtualChainChanged` (empty add/remove delta in the observed sample)
- `kasgraph-node` capability-gating was factored into a dedicated helper and now has direct unit coverage for rejecting:
  - `rpcApiVersion < 1`
  - missing `hasMessageId`
  - missing `hasNotifyCommand`
- Verification after the change:
  - `cargo fmt`
  - `cargo test -p kasgraph-rpc -p kasgraph-node`
  - `cargo run -p kasgraph-rpc --example live_wrpc_smoke`
  - full `cargo test`
- This closes another real gap: repo-local live validation no longer depends on external scratch scripts, and public `wss://` endpoints now actually work through the in-tree client.

## Previous commit arc (2026-05-26 — capability probe landed for continuous mode)

- `kasgraph-rpc` now exposes `probe_live_capabilities()`, which calls `getServerInfo` plus `getInfo` against the configured endpoint and returns parsed capability data.
- New parsed structs landed in `kasgraph-rpc`: `ServerInfo`, `NodeInfo`, and `LiveRpcCapabilities`.
- `kasgraph-node` continuous mode now runs that probe before subscribing and bails early if the node does not advertise:
  - `rpcApiVersion >= 1`
  - `hasMessageId = true`
  - `hasNotifyCommand = true`
- Unsynced nodes are now surfaced as a warning during preflight instead of being silently accepted.
- New regression tests:
  - `probe_live_capabilities_reads_http_endpoint`
  - `probe_live_capabilities_reads_wrpc_json_endpoint`
- `cargo test -p kasgraph-rpc -p kasgraph-node` and full `cargo test` are green after the capability-probe change.
- This tightens the live path meaningfully: continuous ingestion now fails fast on incompatible public nodes instead of getting further into subscribe/recovery flows before exploding.

## Previous commit arc (2026-05-26 — point RPC over JSON wRPC landed)

- Follow-up live probing against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json` confirmed that point calls like `getBlock`, `getBlockDagInfo`, and `getVirtualChainFromBlock` work over the same JSON wRPC websocket path, not just `getServerInfo` / `getInfo` and subscriptions.
- `crates/kasgraph-rpc/src/lib.rs` now detects `ws://` / `wss://` endpoint URLs for point RPC and performs a one-shot JSON wRPC request instead of assuming HTTP POST.
- The wRPC point-response shape is normalized so existing parsers can consume live responses that come back as `{"method":"getBlock", "params": {...}}` rather than HTTP-style `{"result": {...}}`.
- New regression tests:
  - `fetch_block_supports_wrpc_json_endpoint`
  - `recover_blocks_in_daa_range_supports_wrpc_json_endpoint`
- `cargo test -p kasgraph-rpc` and full `cargo test` are green after the ws point-RPC fallback change.
- This closes a real Phase 2.3 gap: the confirmed public node can now support subscription, hash hydration, and anchor-based recovery through the same public websocket endpoint instead of needing a separate HTTP JSON-RPC URL.

## Previous commit arc (2026-05-26 — real live wRPC framing validated and code retargeted)

- A reachable public mainnet node was confirmed: `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`.
- Live probing showed `getServerInfo` and `getInfo` both succeed there, while the earlier guessed `notifyBlockAdded` / `notifyVirtualChainChanged` methods fail with `RPC method not found`.
- Upstream client source (`kaspa-wrpc-client`) was checked and confirmed that live notifications use generic `subscribe` / `unsubscribe` RPC ops carrying a serialized `Scope` payload, not `notify*` RPC methods.
- Live probing then confirmed the actual JSON wire shape:
  - subscribe request: `{"method":"subscribe","params":{"BlockAdded":{}}}`
  - virtual-chain subscribe request: `{"method":"subscribe","params":{"VirtualChainChanged":{"include_accepted_transaction_ids":false}}}`
  - subscribe ack: `{"method":"subscribe","params":{"id":...}}`
  - live notifications: `blockAddedNotification` / `virtualChainChangedNotification` with nested `params.BlockAdded` / `params.VirtualChainChanged` payloads
- `crates/kasgraph-rpc/src/lib.rs` was updated to use those real subscribe payloads, recognize lowercase `*Notification` method names, and unwrap the nested scope payload before parsing.
- `cargo test -p kasgraph-rpc` and full `cargo test` are green after the live-wire-format change.
- Resolver/public-node discovery is still noisy from this environment (`403` / `404` / `523` / SSL mismatch on other candidates), but true wire validation is no longer blocked.

## Previous commit arc (2026-05-26 — anchor-based active gap recovery)

- `MultiRpcClient` now exposes `recover_blocks_in_daa_range(start_hash, from, to)`, which calls `getVirtualChainFromBlock`, parses `removedChainBlockHashes` / `addedChainBlockHashes`, fetches the added blocks, and filters them to the requested DAA window before re-emitting a `VirtualChainChanged` notification.
- `IngestionState::recovery_anchor_hash(from_daa)` derives the highest locally known pre-gap block hash from committed + probabilistic state.
- `run_continuous_ingestion` now prefers anchor-based recovery for `RecoveryRequired` events and only falls back to `KASGRAPH_GAP_RECOVERY_BLOCK_HASHES` when no local anchor can be derived.
- New tests: `recover_blocks_in_daa_range_uses_virtual_chain_delta` in `kasgraph-rpc` and `recovery_anchor_hash_prefers_highest_known_block_below_gap_start` in `kasgraph-node`.
- `cargo test -p kasgraph-rpc -p kasgraph-node` is green.

## Previous commit arc (2026-05-26 — health-probe loop in continuous mode)

- `run_continuous_ingestion` now spawns `MultiRpcClient::spawn_health_probe_loop` alongside the subscription driver, so `endpoint_health()` stays fresh while the wRPC subscription is the only active traffic.
- The probe handle is explicitly aborted on exit (the loop has no built-in shutdown signal); without that the task would keep firing every interval until process exit.
- No test surface change — the probe loop is a background timer best validated via integration tests. The build remained green at 59 tests before the unrelated `kasgraph-stream` failure below.

## Previous commit arc (2026-05-26 — active gap recovery on the consumer side)

- `apply_and_persist_notification` now returns `NotificationOutcome { recovery_requested, committed_count }` so the continuous loop can react to gap announcements.
- New `KASGRAPH_GAP_RECOVERY_BLOCK_HASHES` env (parsed into `ContinuousConfig.gap_recovery_block_hashes`) feeds runtime gap recovery; distinct from the existing `KASGRAPH_RECOVERY_BLOCK_HASHES` which only drives bootstrap replay.
- When `outcome.recovery_requested` is `Some((from, to))` AND the hash list is non-empty AND a client is available, the loop calls `MultiRpcClient::recover_blocks_by_hashes(hashes, from, to)` and re-applies the resulting `VirtualChainChanged` through the same persist helper. A second-level recovery is intentionally not chased — one-level guard prevents recovery storms.
- When the hash list is empty, the gap is logged with a clear "skipping active recovery" warning so operators know what to set.
- Two new node tests: `continuous_config_defaults_match_documented_values` extended to assert gap hashes default empty; `notification_outcome_default_indicates_no_recovery_and_no_writes` pins the outcome shape.
- 59 tests total. `BLOCKDAG_REORG_SEMANTICS.md` gains an "Active gap recovery in continuous mode" subsection; STATUS.md updated.

## Previous commit arc (2026-05-26 — gap-aware recovery on reconnect)

- New private `DriverState { last_emitted_daa, pending_gap_check }` lives in `run_continuous_subscription` and survives across reconnects.
- `pending_gap_check` is set after every reconnect (transport error *or* clean disconnect) but never on the initial connect.
- When set, the next DAA-bearing notification triggers a check: if its lowest DAA is more than one beyond the last emitted DAA, the driver sends a synthetic `RecoveryRequired { from_daa_score: last + 1, to_daa_score: first - 1, reason: "subscription gap after reconnect…" }` onto the same channel before forwarding the actual notification.
- `first_daa_of` / `max_daa_of` helpers handle the per-variant payload shape; `RecoveryRequired` carries no DAA and does not advance `last_emitted_daa`.
- Two new rpc tests: the skip-DAA case emits the synthetic recovery in correct order; the contiguous case emits no synthetic recovery. The receiver-drop, max-attempts, and reconnect-with-contiguous-batch tests all still pass.
- `BLOCKDAG_REORG_SEMANTICS.md` gains a "Gap detection at reconnect" subsection.
- 58 tests total. The downstream node `IngestionState` already handles `RecoveryRequired` (rolls back probabilistic in range, surfaces `recovery_requested`), so no consumer changes were needed.

## Previous commit arc (2026-05-26 — continuous wRPC ingestion wired end-to-end)

- The per-notification persist work (apply → unwind → POI re-anchor → POI/audit/committed-block writes) is now a single `apply_and_persist_notification` helper called by both the bootstrap and continuous paths.
- New `IngestMode { Bootstrap, Continuous }` selected via `KASGRAPH_INGEST_MODE` (defaults to `bootstrap`; unknown values warn and fall back).
- New `ContinuousConfig` wired from env: `KASGRAPH_NOTIFICATION_WS_URL`, `KASGRAPH_NOTIFICATION_SOURCE_LABEL`, `KASGRAPH_CONTINUOUS_MAX_MESSAGES` (0 = forever), `KASGRAPH_CONTINUOUS_CHANNEL_CAPACITY`, `KASGRAPH_CONTINUOUS_BACKOFF_INITIAL_MS`/`_MAX_MS`/`_MULTIPLIER`/`_MAX_ATTEMPTS`.
- `run_continuous_ingestion` spawns `MultiRpcClient::spawn_continuous_subscription`, consumes from `mpsc::Receiver` in a `tokio::select!` against `tokio::signal::ctrl_c()`, applies each notification through the shared helper, exits cleanly on Ctrl-C / max-messages / driver channel close, drops the receiver, and awaits the driver handle.
- Three new node tests cover the IngestMode default, ContinuousConfig defaults, and the missing-ws-url validation bail. The continuous-config preflight is factored into `validate_continuous_config` so tests don't need a live Store.
- 56 tests total. `BLOCKDAG_REORG_SEMANTICS.md` marks the continuous wRPC subscription as fully landed.

## Previous commit arc (2026-05-26 — continuous wRPC subscription primitive)

- `SubscriptionBackoff { initial_delay, max_delay, multiplier, max_attempts }` config struct (with sensible `Default`).
- `MultiRpcClient::spawn_continuous_subscription(url, served_by, sender, backoff) -> JoinHandle<()>` runs a long-lived driver that subscribes, parses, and forwards each `ChainNotification` onto an `mpsc::Sender`. Exponential backoff on transport errors; backoff resets on clean disconnect; cooperative shutdown via `tokio::select!` on `sender.closed()` even when blocked on `read.next()`; gives up after `max_attempts` (0 = forever).
- Three new tests against new mock helpers (`spawn_mock_ws_server_multi`, `spawn_mock_ws_server_idle`): reconnect after server-side disconnect delivers both batches; receiver-drop mid-stream exits the driver; unreachable URL plus `max_attempts = 2` exits the driver promptly.
- 53 tests total. `BLOCKDAG_REORG_SEMANTICS.md` updated to mark the continuous primitive as landed, with node-side wiring as the next jump.

## Previous commit arc (2026-05-26 — POI re-anchor on resume)

- `Store::latest_poi_for_subgraph(subgraph) -> Option<PoiCheckpoint>` returns the highest-DAA surviving POI row.
- `IngestionState::reseed_prior_poi(prior_poi)` sets the in-memory hash chain anchor.
- `kasgraph-node` startup path now loads the latest POI for the configured subgraph and re-seeds `IngestionState.prior_poi` from it — restarts continue the same hash chain.
- After each committed unwind, the node loop re-loads the latest POI and re-seeds `prior_poi` from the new survivor (or `[0u8; 32]` if nothing survives) so the next committed block hashes from the survivor, not the deleted block.
- Two new node-side tests confirm: a re-seeded chain produces the same POI as a natural continuation; re-seeding to the default zero anchor restarts genesis-style.
- 50 tests total, all green. `BLOCKDAG_REORG_SEMANTICS.md` "what the scaffold does" table now lists POI re-anchoring as "yes".

## Previous commit arc (2026-05-26 — committed-state unwind)

- New migration `20260526150000_committed_unwind.sql` adds `kasgraph_committed_block` (per-subgraph hash → daa/served_by index) and `kasgraph_reorg_audit` (per-unwind record with removed-hash array, reason, timing).
- `Store::record_committed_block` and `Store::unwind_committed_blocks_for_subgraph` land. Unwind runs in one SQL transaction: lookup committed rows → delete matching POI + audit + committed-block rows → insert reorg audit row → return `CommittedUnwindReport { removed_hashes, audit_id }`.
- `IngestionState` gains `remove_committed_by_hashes` and surfaces `committed_unwinds: Vec<BootstrapBlock>` on the transition struct. `kasgraph-node` calls the Store unwind whenever the transition reports any.
- Node persistence loop now also writes `kasgraph_committed_block` rows alongside POI + audit so the unwind has something to delete.
- Two new node-side tests: `virtual_chain_changed_surfaces_committed_unwinds_for_committed_removals` and `block_added_notification_does_not_emit_committed_unwinds`. Migrator test updated to expect 2 migrations.
- `BLOCKDAG_REORG_SEMANTICS.md` "what the scaffold does" table updated.

## Current state (2026-05-26)

- Workspace scaffold landed (cargo + npm workspaces, CI, vitest).
- Seven Rust crates compile; `kasgraph-poi` ships real logic + unit tests (blake2b-256 hash chain).
- `kasgraph-rpc` now has an initial real multi-RPC client: primary-first failover, rotating backup order, health probes, background probe-loop helper, and in-memory block audit records with regression tests.
- `kasgraph-store` now has its first real migration slice plus a live `Store` API for covenant lineage heads/rows, POI checkpoints, RPC audit inserts, and per-subgraph schema bootstrap.
- `kasgraph-node` now uses that store in a bootstrap path: if `KASGRAPH_DATABASE_URL` is set, it runs migrations, ensures the subgraph schema, processes minimal live-style notifications, fetches one or more real blocks through `kasgraph-rpc` when `KASGRAPH_RPC_PRIMARY_URL` is configured, buffers probabilistic blocks separately from committed blocks, rolls back conflicting probabilistic ranges, can request a small recovery replay window, computes scaffold POI hashes for committed blocks, and writes POI plus RPC audit rows.
- `kasgraph-rpc` now exposes a stronger notification/recovery surface: `ChainNotification`, ordered `fetch_blocks`, `recover_blocks_by_hashes`, JSONL parsing, websocket subscription bootstrap, upstream-style notification-envelope parsing, virtual-chain hash hydration, idle-bounded websocket reads (`max_messages = 0` supported for unbounded capture), and fail-fast subscription rejection errors.
- Eight MCP tool names enumerated; manifest type covers all five Kaspa-native data-source kinds.
- Phase 1 reference docs all substantive: `KIP20_COVENANT_ID_QUERIES.md`, `KASPA_RPC_REFERENCE.md`, `THEGRAPH_REFERENCE.md`, `BLOCKDAG_REORG_SEMANTICS.md` (KIP-20 finality + ordered Postgres unwind + POI re-anchoring), and `KRC20_KRC721_REFERENCE.md` (legacy Kasplex + native KCC20 + native KRC-721).
- `kasgraph-detectors` is no longer a single-file scaffold: `fingerprint.rs` defines `Fingerprint` / `MaskedWindow` with masked-byte matching + field-named extraction; `registry.rs` declares 12 OpenSilver core patterns + 5 KCC20 variants with `0xFE`-prefixed placeholder discriminators. 17 unit tests pin the engine and reject cross-pattern collisions.
- Phase 0 ecosystem coordination is **intentionally skipped** per user direction.

## Queue (in priority order)

### 1. Phase 2.3 — BlockDAG-aware RPC ingestion semantics

The Graph compatibility deep dive is now landed in `docs/references/THEGRAPH_REFERENCE.md`.

What landed:

- Minimal committed-vs-probabilistic ingestion state in `kasgraph-node`.
- Minimal live-style notification model in `kasgraph-rpc` / `kasgraph-node` (`BlockAdded`, `VirtualChainChanged`, `RecoveryRequired`).
- JSONL notification parsing in `kasgraph-rpc`, with `KASGRAPH_NOTIFICATION_JSONL` support in `kasgraph-node` so structured event streams can be injected directly.
- Real websocket subscription bootstrap in `kasgraph-rpc` via generic `subscribe` payloads for `BlockAdded` and `VirtualChainChanged`, matching live mainnet wRPC behavior.
- Parsing of upstream-style event envelopes, including real live `blockAddedNotification` / `virtualChainChangedNotification` wrappers with nested scope payloads.
- Virtual-chain hydration in `kasgraph-rpc` so hash-only `virtualChainChanged` websocket payloads are resolved back into fetched blocks.
- Idle-bounded websocket reads in `kasgraph-rpc`, with `max_messages = 0` meaning unbounded capture and `KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS` available in `kasgraph-node` to stop quiet streams cleanly.
- Explicit websocket subscription error handling in `kasgraph-rpc`, so server-side rejections no longer look like an empty or quiet stream.
- Promotion of buffered probabilistic blocks when a finalized block arrives.
- Rollback of conflicting probabilistic ranges before replay.
- Small replay helper in `kasgraph-rpc` for env-driven recovery ranges.

What still needs to land:

- **Active recovery-path validation**: the 60s / 5m / 15m passive soaks are all clean, so the next best move is no longer “wait longer” — it is to force or capture reconnects deliberately. Add optional newline-delimited event-log output from the smoke runner and/or a controlled reconnect/fault-injection harness around `spawn_continuous_subscription_with_events(...)` so gap detection and recovery can be validated against real trace shapes instead of hoping the public node flakes.
- **Live-node validation of anchor-based recovery**: now that point RPC over JSON wRPC is wired, use those forced/captured reconnect traces to inspect the exact `getVirtualChainFromBlock` responses and confirm the new recovery path behaves correctly across reconnects and deeper selected-chain churn.
- **Next likely code move**: extend `continuous_wrpc_smoke` with optional NDJSON event output (driver events + notification summaries) and then add a targeted integration test or mock harness that simulates reconnect + stale replay + overlap patterns while persisting the resulting trace artifact.

### 2. Phase 2.4 follow-through — real DB-backed tests and node integration

The first schema is now in `crates/kasgraph-store/migrations/20260526110500_initial_kip20_lineage.sql` and includes:

- `kasgraph_covenant_lineage_head`
- `kasgraph_covenant_lineage_row`
- `kasgraph_poi`
- `kasgraph_rpc_block_audit`

Next finishers for this slice:

- Add `sqlx::test` coverage once a Postgres test database is wired.
- Call `Store::migrate()` and persistence methods from `kasgraph-node`.
- Replace in-memory RPC audit retention with store-backed writes.

### 3. Phase 2.5 — Replace placeholder fingerprints with real OpenSilver compiled bytes

The fingerprint engine and per-pattern registry are live. What remains:

- Extend the OpenSilver manifest pipeline (`artifacts/manifests/`) to emit a per-pattern `compiledScriptBytes` (hex) + `stateLayout` (field name → offset/len) entry. Today `ide-all.json` carries metadata but not bytes.
- Add a `cargo xtask sync-opensilver-fingerprints` task in this repo that ingests that JSON and rewrites `crates/kasgraph-detectors/src/registry.rs`'s entry bodies. The current `opensilver()` builder is exactly the shape the sync should produce.
- After sync, the cross-pattern non-collision test will run against real bytes; if any two patterns collide, that is a real bug in the upstream compile pipeline (typically a missed entry-point discriminator).
- Skipped variants — `ZkVerifiedComputation`, `ZkPrivateAssetTransfer`, `ZkVerifiedOracle`, `ZkVerifiedOracleV2`, `ZkProofStitchedMultiPattern`, `Krc721Collection`, `Krc721Nft`, `KasBondsBond` — need their own registry entries once OpenSilver Phase 5 artifacts and the KRC-721 spec land.

### 4. Phase 2.8 — POI integration into the (stub) ingestion loop

`kasgraph-poi` is already real. Wire it into `kasgraph-node` so even the scaffold ingestion writes one POI per block to a `kasgraph_poi` Postgres table.

## Fresh notes from this session

- `crates/kasgraph-rpc/src/lib.rs` is no longer a pure stub. It already exposes `fetch_block`, `probe_health_once`, `spawn_health_probe_loop`, `endpoint_health`, and `audit_log`.
- The current client speaks JSON-RPC over HTTP with `getBlock` and `getBlockDagInfo` payloads, and now also has an initial websocket subscription bootstrap for `notifyBlockAdded` / `notifyVirtualChainChanged`.
- `crates/kasgraph-store/src/lib.rs` now embeds migrations via `sqlx::migrate!` and validates `SubgraphId` to keep dynamic schema creation safe.
- `crates/kasgraph-node/src/main.rs` now has a real async bootstrap path keyed off `KASGRAPH_DATABASE_URL`, `KASGRAPH_SUBGRAPH`, `KASGRAPH_BLOCK_HASHES` (or single `KASGRAPH_BLOCK_HASH`), `KASGRAPH_REMOVED_BLOCK_HASHES`, `KASGRAPH_RECOVERY_BLOCK_HASHES`, `KASGRAPH_RECOVERY_RANGE`, `KASGRAPH_NOTIFICATION_JSONL`, `KASGRAPH_NOTIFICATION_WS_URL`, `KASGRAPH_NOTIFICATION_SOURCE_LABEL`, optional `KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS`, and RPC env vars such as `KASGRAPH_RPC_PRIMARY_URL` / `KASGRAPH_RPC_BACKUP_URLS`.
- `crates/kasgraph-rpc/src/lib.rs` now has the first public notification abstraction for live subscription code, a parser for line-delimited JSON event feeds, websocket subscribe-message bootstrap, envelope parsing that accepts both scaffold-style `kind` payloads and upstream-style websocket event wrappers, and fast-fail handling for explicit subscription rejection payloads.
- The current POI bytes are still derived from block metadata only (`hash`, `daa`, `blue`, `finalized`, `served_by`). That is good enough for scaffold wiring, not for final indexing correctness.
- The current reorg handling is intentionally limited: committed conflicts are logged and ignored until deeper rollback support lands; only probabilistic ranges are actively rolled back.
- Existing tests use fast unit coverage only. No live Postgres fixture is wired yet, so the next useful jump is `sqlx::test` once `DATABASE_URL` or a dedicated test setup exists.

## Fresh blocker note

- General public-node discovery is still flaky from this environment. One live node is confirmed reachable (`eric.kaspa.stream`) and now usable for both subscriptions and point RPC, but other resolver/public-node candidates were still returning 403/404/523 or SSL mismatch responses, so there is not yet a robust multi-node discovery path for broader live validation.

## Optional / longer-horizon

- **Phase 1.3** — Kasplex indexer + krc721.stream open-source-code review. Pull patterns that work at Kaspa scale; flag what KasGraph should improve. The legacy-KRC-20 acceptance rules in `KRC20_KRC721_REFERENCE.md` should be validated block-for-block against Kasplex's mainnet output as soon as the legacy ingest path lands.
- **Phase 3.1 prep** — GraphQL gateway server choice (Apollo / Yoga / Mercurius). Stub `@kasgraph/api` is ready for the choice.
- **Committed-state SQL unwind** — implement the ordered rollback procedure described in `BLOCKDAG_REORG_SEMANTICS.md` once the next migration slice (per-block acceptance index + `kasgraph_reorg_audit`) lands.

## User-gated items

- Phase 0 outreach (Kaspa Foundation, Kasplex, kas.fyi, krc721.stream, Michael Sutton, Hans Moog, wallet teams).
- Hosted-service infrastructure (Phase 5 — cloud provider, Postgres deploy shape, kasgraph.io DNS / TLS).
- Push the repo to a GitHub remote.

## Cross-references

- `PLAN.md` — source of truth for every phase.
- `STATUS.md` — live status block updated after each commit arc.
- `docs/references/` — Phase 1 reference docs.
- Sibling `OpenSilver` repo — source of pattern fingerprints for `kasgraph-detectors`.
