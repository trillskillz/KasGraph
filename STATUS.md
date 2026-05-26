# KasGraph — Status

```
PHASE_0_STATUS: SKIPPED (per user direction; ecosystem outreach deferred to a separate track)
PHASE_1_STATUS: IN_PROGRESS (reference docs landed under docs/references/; KIP-20, Kaspa RPC, The Graph compatibility, BlockDAG reorg semantics, and KRC20/KRC721 deep dives now all real — only the live-fork sections on KRC-721 native await ecosystem decisions)
PHASE_2_STATUS: IN_PROGRESS (Phase 2.1 scaffold complete; Phase 2.2 initial multi-RPC client landed; Phase 2.3 now includes websocket subscription bootstrap, notification-envelope parsing, hash-to-block virtual-chain hydration, configurable idle-bounded websocket reads, fail-fast subscription rejection handling, probabilistic-vs-committed ingestion state, and committed-state SQL unwind on removed_chain_block_hashes; Phase 2.4 now has two store schema slices (initial covenant lineage + POI + audit, plus committed-block + reorg-audit); Phase 2.5 fingerprint engine + per-pattern registry scaffolded with masked-state-window matching and 17 unit tests — placeholder bytes wait on OpenSilver compiled-script export; full continuous network wRPC ingestion + POI re-anchor on resume still remain in 2.3, plus 2.6-2.8)
PHASE_3_STATUS: NOT_STARTED (GraphQL + MCP + KasStream + WebSocket; ships simultaneously)
PHASE_4_STATUS: NOT_STARTED (CLI surface scaffolded; command bodies pending)
PHASE_5_STATUS: NOT_STARTED (hosted service)
PHASE_6_STATUS: NOT_STARTED (six reference subgraphs)
PHASE_7_STATUS: NOT_STARTED (integrations)
PHASE_8_STATUS: NOT_STARTED (Toccata-window mainnet launch)
PHASE_9_STATUS: DEFERRED (post-launch roadmap; documented, not executed)
COMPONENTS_LIVE: workspace scaffold (cargo + npm workspaces, CI, vitest, basic test surface) + initial kasgraph-rpc failover client with health probes and audit log + ChainNotification / recovery helpers plus JSONL parsing, websocket subscription bootstrap, notification-envelope parsing, and virtual-chain hash hydration in kasgraph-rpc + first kasgraph-store migration slice for covenant lineage, POI, and RPC audit tables + kasgraph-node path that runs migrations, ensures a subgraph schema, can ingest parsed live-style notifications, buffers probabilistic blocks separately from committed blocks, rolls back conflicting probabilistic ranges, requests small recovery replays, and persists scaffold POI/audit records for committed blocks + kasgraph-detectors fingerprint engine (masked-state-window matching with field-named extraction) and registry covering 12 OpenSilver core patterns plus 5 KCC20 variants
TESTNET_INDEXED_BLOCKS: 0
SUBGRAPHS_DEPLOYED: 0
QUERY_LATENCY_P95: N/A
MCP_TOOLS_LIVE: 0 (8 typed names exposed; bodies pending)
BLOCKERS: NONE for continuing Phase 1 / Phase 2.2-2.8 autonomously. Phase 5 (hosted service) needs infrastructure decisions before it can start.
NEXT_PHASE: Phase 2.3 live wRPC ingestion plus the BlockDAG semantics reference, using the new Kaspa RPC and The Graph compatibility docs as guardrails.
```

## What's done

- Repo initialized with MIT license, comprehensive `README.md`, `PLAN.md` copied in, `STATUS.md` + `NEXT_SESSION.md` + `CONTRIBUTING.md` in place.
- **Cargo workspace** with seven crates per PLAN.md Phase 2.1: `kasgraph-node`, `kasgraph-rpc`, `kasgraph-store`, `kasgraph-mapping`, `kasgraph-detectors`, `kasgraph-poi`, `kasgraph-stream`. Each compiles standalone; `kasgraph-node` links the others.
- **npm workspace** with four packages: `@kasgraph/sdk`, `@kasgraph/cli`, `@kasgraph/api`, `@kasgraph/mcp`. Strict TypeScript config; vitest configured.
- **CI** workflow under `.github/workflows/ci.yml` runs `npm run typecheck` + `npm test` + `cargo build --workspace --all-targets` + `cargo test --workspace`.
- **POI module** (`kasgraph-poi`) is the first crate with real logic — blake2b-256 hash chain with deterministic-chain regression tests. POI = `blake2b-256(prior_poi || sorted_canonical_entity_state)`.
- **kasgraph-rpc** now has a real initial client: primary-first failover, rotating backup order, one-shot health probes, background probe-loop helper, and an in-memory per-block audit log of which endpoint served each block. Regression tests cover failover, backup rotation, health marking, and malformed responses.
- **kasgraph-store** now has two schema slices: the initial covenant-lineage + POI + RPC audit tables, plus a `kasgraph_committed_block` + `kasgraph_reorg_audit` slice that powers committed-state unwind. The live `Store` exposes `record_committed_block`, `unwind_committed_blocks_for_subgraph` (single SQL transaction: ordered deletion of POI + audit + committed-block rows followed by a reorg-audit insert), and `latest_poi_for_subgraph` (highest-DAA surviving checkpoint, used to re-anchor the in-memory POI hash chain on startup and after unwind).
- **kasgraph-rpc** now exposes a more real Phase 2.3 live-ingestion surface: `ChainNotification`, ordered `fetch_blocks`, `recover_blocks_by_hashes`, JSONL notification parsing, websocket subscription bootstrap (`notifyBlockAdded` / `notifyVirtualChainChanged`), notification-envelope parsing for both scaffold and upstream-style event wrappers, virtual-chain hash hydration back into fetched blocks, websocket reads that can run unbounded (`max_messages = 0`) or stop cleanly after a configurable idle timeout, and fail-fast errors when the remote endpoint explicitly rejects a subscription request.
- **kasgraph-node** now wires the first persistence path end-to-end: with `KASGRAPH_DATABASE_URL` set, it connects to Postgres, runs migrations, ensures a subgraph schema, **re-anchors `IngestionState.prior_poi` from the highest-DAA surviving POI before ingestion starts** (so a restart resumes the same hash chain), prefers parsed notification-stream input when `KASGRAPH_NOTIFICATION_JSONL` is provided, can also consume websocket notification streams with `KASGRAPH_NOTIFICATION_WS_URL` plus optional `KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS`, otherwise builds minimal live-style notifications (`BlockAdded`, `VirtualChainChanged`, `RecoveryRequired`), fetches one or more block hashes through `kasgraph-rpc` when `KASGRAPH_RPC_PRIMARY_URL` is configured, keeps probabilistic blocks buffered until a finalized block promotes them, rolls back conflicting probabilistic ranges before replay, invokes the committed-state SQL unwind procedure when `VirtualChainChanged.removed_chain_block_hashes` matches already-committed blocks **and re-anchors the POI chain from the new survivor after each unwind**, can request a small recovery replay window, computes scaffold POI hashes for committed blocks, and persists POI, RPC audit, and committed-block tracking records. It still falls back to synthetic scaffold data when RPC env is absent.
- **MCP tool surface** (`@kasgraph/mcp`) enumerates the eight tools from PLAN.md Phase 3.2 verbatim; a regression test pins the list so docs + code can't drift.
- **Manifest types** (`@kasgraph/sdk`) cover all five Kaspa-native data-source kinds (`covenant_id`, `krc20`, `krc721`, `address`, `utxo`).
- **Phase 1 reference docs** all real under `docs/references/`: `KIP20_COVENANT_ID_QUERIES.md`, `KASPA_RPC_REFERENCE.md`, `THEGRAPH_REFERENCE.md`, `BLOCKDAG_REORG_SEMANTICS.md` (KIP-20 finality, virtual-chain reorg surface, ordered Postgres unwind, POI re-anchoring, replay-safety contract), and `KRC20_KRC721_REFERENCE.md` (legacy Kasplex inscription rules + native KCC20 asset+controller model + native KRC-721 collection/per-NFT shape).
- **Phase 2.5 detector engine** (`kasgraph-detectors`) — `Fingerprint` with masked state windows, field-named extraction, and per-pattern registry covering 12 OpenSilver core patterns plus 5 KCC20 variants. Placeholder canonical bytes use a `0xFE`-prefixed discriminator so no real chain script collides; real OpenSilver compiled bytes wire into the registry without touching the engine. 17 unit tests cover matching, extraction, validation, registry uniqueness, and cross-pattern non-collision.

## What's blocked on the user

- **Phase 0 ecosystem coordination.** User explicitly skipped this for now. Outreach to Kaspa Foundation, Kasplex, kas.fyi, krc721.stream maintainers, Michael Sutton, Hans Moog, wallet teams remains a launch-day prerequisite per PLAN.md, but does not block implementation.
- **Hosted infrastructure decisions** (Phase 5): cloud provider, k8s vs systemd, Postgres deploy shape.
- **kasgraph.io domain registration** and TLS infra.
- **GitHub remote setup** — repo not yet pushed.

## What can be done autonomously next

1. **Phase 2.3 follow-through** — Extend the new websocket subscription bootstrap and idle-bounded reads into a continuous live wRPC loop, validate real transport framing/ack payloads against an actual Kaspa node, implement removed-chain rollback for committed state per `BLOCKDAG_REORG_SEMANTICS.md`, and anchor missed-event recovery to actual subscription gaps instead of configured replay hashes.
2. **Phase 2.4/2.8 follow-through** — Replace the current metadata-only POI scaffold with canonical entity-state bytes from real ingestion, add `sqlx::test` coverage against a real Postgres fixture, and persist actual RPC audit rows from the live ingest loop instead of a bootstrap-style pass.
3. **Phase 2.5 finisher** — Replace placeholder canonical bytes in `kasgraph-detectors::registry` with real OpenSilver compiled-script bytes via a `cargo xtask sync-opensilver-fingerprints` task that pulls from `OpenSilver/artifacts/manifests/` once that pipeline exports compiled bytes. Engine and tests stay as-is.
4. **Phase 2.8** — Extend the current committed-block write path into the real ingestion loop so every committed block emits a checkpoint.

## Performance targets to hit (from PLAN.md)

| Target | Goal |
| --- | --- |
| Indexing latency | < 30 s of chain tip at p99 |
| GraphQL p95 | < 200 ms |
| GraphQL p99 | < 500 ms |
| Streaming latency | sub-second |
| Concurrent subgraphs per node | 100+ |
| Uptime during incubation | 99.5% |

## Cross-project compounding

- **OpenSilver** (sibling repo): KasGraph's `kasgraph-detectors` crate will consume OpenSilver's pinned compiled scripts to fingerprint covenant patterns on-chain. The OpenSilver manifest pipeline (`artifacts/manifests/`) is the source of truth.
- **KasBonds**: First reference subgraph (PLAN.md Phase 6.1). Migrates from custom indexing.
