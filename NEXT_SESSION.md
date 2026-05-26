# Next-session queue

Autonomous work picked up by the next agent run. Phase 1 reference docs are now all real; Phase 2.5 detector engine + per-pattern registry is scaffolded with 17 unit tests. Next jumps are the continuous wRPC loop, committed-state SQL unwind, and the OpenSilver fingerprint sync.

## Latest commit arc (2026-05-26 — active gap recovery on the consumer side)

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
- Initial websocket subscription bootstrap in `kasgraph-rpc` (`notifyBlockAdded` + `notifyVirtualChainChanged`), including parsing of upstream-style event envelopes.
- Virtual-chain hydration in `kasgraph-rpc` so hash-only `virtualChainChanged` websocket payloads are resolved back into fetched blocks.
- Idle-bounded websocket reads in `kasgraph-rpc`, with `max_messages = 0` meaning unbounded capture and `KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS` available in `kasgraph-node` to stop quiet streams cleanly.
- Explicit websocket subscription error handling in `kasgraph-rpc`, so server-side rejections no longer look like an empty or quiet stream.
- Promotion of buffered probabilistic blocks when a finalized block arrives.
- Rollback of conflicting probabilistic ranges before replay.
- Small replay helper in `kasgraph-rpc` for env-driven recovery ranges.

What still needs to land:

- **Live-network validation**: point continuous mode at a real Kaspa wRPC node and confirm the JSON framing assumed by `parse_ws_message` matches the wire format. If the upstream sends bincode or a different envelope shape, extend the parser; the rest of the pipeline does not change.
- **Real DAA-range RPC method**: `MultiRpcClient::fetch_blocks_in_daa_range(from, to)` so active gap recovery does not need an operator-curated hash list. Today the path uses `recover_blocks_by_hashes`, which means operators have to know the missing hashes ahead of time — fine for forensic replay, not for unattended gap recovery.
- **Periodic health-probe loop** in the long-lived path so endpoint health stays fresh while the wRPC subscription is the only active traffic.

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
