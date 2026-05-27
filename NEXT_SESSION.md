# Next-session queue

Autonomous work picked up by the next agent run. Phase 1 reference docs are now all real; Phase 2.5 detector engine + per-pattern registry is scaffolded with 17 unit tests. Next jumps are live-node wRPC validation, deeper recovery semantics, and the OpenSilver fingerprint sync.

## Latest commit arc (2026-05-26 — detector hits persisted + POI now reflects them)

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
