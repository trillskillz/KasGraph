# KasGraph

> The Graph for Kaspa, AI-native from day one. A subgraph-style indexing protocol with GraphQL, MCP, and streaming, redesigned around Kaspa's UTXO model, KIP-20 Covenant IDs, native KRC-20 / KRC-721, and the agent era.

[![CI](https://github.com/trillskillz/KasGraph/actions/workflows/ci.yml/badge.svg)](https://github.com/trillskillz/KasGraph/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/Rust-indexer_core-orange.svg)](crates/)
[![TypeScript](https://img.shields.io/badge/TypeScript-SDK_·_CLI_·_API_·_MCP-3178c6.svg)](sdk/)
[![MCP](https://img.shields.io/badge/MCP-first_class-blueviolet.svg)](mcp/)
[![KIP-20](https://img.shields.io/badge/KIP--20-covenant_ids_first_class-blue.svg)](docs/references/KIP20_COVENANT_ID_QUERIES.md)

**Why this exists**: Kaspa's own developer docs list structured data querying as missing. The community API is best-effort with no SLA. Kasplex covers inscription-style KRC-20 (legacy); krc721.stream covers legacy NFTs. With Toccata landing covenants, native KRC-20, and ZK opcodes, every serious dApp needs structured data querying, plus an MCP surface so AI agents can use it without writing GraphQL.

KIP-20 Covenant IDs make this dramatically easier than EVM indexing: stable, consensus-tracked identifiers for stateful contracts mean lineage queries are a primary-key lookup. No recursive UTXO walking. No event-log parsing heuristics.

## Four interfaces, one data plane

```
                  +----------------------------+
                  |  Your dApp / wallet / LLM  |
                  +----------------------------+
                              |
       +--------------+-------+---------+--------------+
       v              v                 v              v
   GraphQL          MCP            KasStream        WebSocket
  subgraph     AI natural     sub-second event   push subscriptions
   queries     language         streaming
       +--------------+--------+--------+--------------+
                               v
                       KasGraph Node (Rust)
                  ingest -> detect -> map -> POI
                               |
                          PostgreSQL
                               |
                  Rusty Kaspa RPC (multi-source, failover)
```

All four interfaces ship together. MCP is a first-class surface, not a future addition.

## What it does

- **Subgraph indexing for Kaspa.** Author a `subgraph.yaml` + `schema.graphql` + an AssemblyScript mapping, then `build` and `deploy`. The node indexes matching on-chain activity into typed entities you query over GraphQL.
- **KIP-20 Covenant ID lineage** as a first-class entity, including the fork-aware DAG that a per-UTXO token model produces (each lineage row records its parent edge and forward children).
- **Built-in pattern detection.** 17 covenant fingerprints captured from real `silverc` compiles (the OpenSilver core patterns + the native KCC20 asset and its four controllers), plus legacy KRC-20 / KRC-721 inscription parsing and ledger state machines. Subgraphs subscribe to typed detector events; they do not write detection code.
- **Typed per-subgraph GraphQL.** Each deployed subgraph gets its own schema generated from its `schema.graphql`, with relation and `@derivedFrom` resolution.
- **MCP server** over the same data plane: `list_subgraphs`, `get_schema`, `execute_query`, `search_by_pattern`, `get_covenant_lineage`. An agent can explore and query a subgraph without writing GraphQL by hand.
- **BlockDAG-aware ingestion.** Multi-RPC failover, continuous wRPC subscription with backoff reconnect and gap recovery, probabilistic-vs-committed block buffering, and reorg-safe unwind.
- **Proof of Indexing.** A blake2b-256 hash chain over each block's dispatched entity state, with an independent third-party verifier, so two honest indexers produce a byte-identical, verifiable chain.

## Status

The indexer is **feature-complete core infrastructure**: `build -> deploy -> index -> query` is multi-tenant, hot-reloadable, and verified end-to-end against a real Postgres. Hosted deploy writes support bearer-token auth, and the API exposes `/healthz`, `/health`, `/status`, and `/metrics` for operators. Remaining pre-public work is operational validation: live hosted testnet indexing, published benchmarks, sustained soak evidence, and protected log streaming. See [`STATUS.md`](STATUS.md) for the live per-phase block.

## Quick start

```bash
git clone https://github.com/trillskillz/KasGraph && cd KasGraph
npm install
npm run verify        # tsc -b  +  vitest  +  cargo test --workspace
```

Scaffold, build, and deploy a subgraph with the CLI:

```bash
npx kasgraph init my-subgraph
cd my-subgraph
# edit schema.graphql + src/mapping.ts
npx kasgraph codegen                                   # generate types from schema.graphql
npx kasgraph build                                     # compile the AssemblyScript mapping to wasm
npx kasgraph deploy --database-url "$DATABASE_URL"     # or: --node https://your-node
npx kasgraph status my-subgraph
```

Run the indexer node against the deployed set:

```bash
DATABASE_URL="$DATABASE_URL" \
KASGRAPH_INGEST_MODE=continuous \
KASGRAPH_NOTIFICATION_WS_URL=wss://your-kaspa-node/wrpc/json \
KASGRAPH_RELOAD_INTERVAL_SECS=30 \
  cargo run -p kasgraph-node
```

The node reads its active subgraph set from the registry, materializes each deployed mapping, fans every block out to all of them, and picks up new `deploy`/`remove` calls on the reload interval without a restart.

## CLI

| Command | What it does |
| --- | --- |
| `kasgraph init <name>` | Scaffold a new subgraph (manifest, schema, mapping, README) |
| `kasgraph codegen` | Generate TypeScript types from `schema.graphql` + the manifest |
| `kasgraph build` | Compile the AssemblyScript mapping to ABI-compliant wasm + a `build/manifest.json` |
| `kasgraph deploy` | Package the built subgraph and register it (`--database-url` direct, or `--node <url>` over HTTP) |
| `kasgraph status <subgraph>` | Report a deployed subgraph's registry state |
| `kasgraph remove <subgraph>` | Soft-remove a subgraph (the gateway stops serving it) |
| `kasgraph mcp-config` | Emit an MCP server config for Claude / Cursor / OpenClaw |

## Subgraph model

Same developer experience as The Graph, with Kaspa-native primitives:

```yaml
specVersion: 0.1.0
name: my-kasbonds-subgraph
schema:
  file: ./schema.graphql
dataSources:
  - name: KasBonds
    network: kaspa-mainnet
    kind: covenant_id
    source:
      ids:
        - "0xabc..."
        - pattern: "opensilver.escrow.milestone"
    mapping:
      file: ./src/mapping.ts
      handlers:
        - event: CovenantLocked
          handler: handleLock
        - event: CovenantSpent
          handler: handleSpent
```

`kind: covenant_id` and `kind: krc721` are native Kaspa primitives. Also supported: `kind: krc20`, `kind: address`, `kind: utxo`.

## Configuration

The indexer node is configured by environment variable. The most common:

| Env var | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string (migrations, registry, per-subgraph schemas, POI) |
| `KASGRAPH_INGEST_MODE` | `bootstrap` (default) or `continuous` |
| `KASGRAPH_NOTIFICATION_WS_URL` | Kaspa wRPC websocket endpoint for continuous ingestion |
| `KASGRAPH_RPC_PRIMARY_URL` / `KASGRAPH_RPC_BACKUP_URLS` | Primary + comma-separated failover RPC endpoints |
| `KASGRAPH_RELOAD_INTERVAL_SECS` | Re-read the registry every N seconds to pick up deploys without a restart (`0` = off) |
| `KASGRAPH_WORK_DIR` | Where deployed mappings are materialized from the registry |
| `KASGRAPH_SUBGRAPH` | Single-subgraph fallback id when the registry is empty (dev) |
| `KASGRAPH_SUBGRAPH_DIR` | Single-subgraph fallback: load a locally-built dir instead of the registry (dev) |
| `KASGRAPH_DEPLOY_TOKEN` | Bearer token required for hosted `POST /subgraphs` and `DELETE /subgraphs/:id`; leave unset only for local/dev |
| `KASGRAPH_ENVIRONMENT` | Operational label returned from `/status`, for example `local` or `testnet` |
| `KASGRAPH_NETWORK` | Kaspa network label returned from `/status`, for example `kaspa-testnet-10` |
| `KASGRAPH_API_VERSION` | Optional API version override returned from `/status` |

The gateway / CLI deploy target accepts `--database-url` (direct) or `--node <url>` / `KASGRAPH_NODE_URL` (hosted HTTP endpoint). Public hosted nodes must set `KASGRAPH_DEPLOY_TOKEN`; clients send `Authorization: Bearer <token>` for deploy/remove writes. The continuous driver exposes additional `KASGRAPH_CONTINUOUS_*` backoff/channel knobs; see `crates/kasgraph-node` for the full set.

Hosted API operators should expose only intended read routes publicly and keep write routes protected. Endpoint docs and production gates live in [`docs/hosted-api.md`](docs/hosted-api.md), [`docs/mainnet-readiness.md`](docs/mainnet-readiness.md), [`docs/runbook.md`](docs/runbook.md), and [`docs/monitoring.md`](docs/monitoring.md).

## Repo map

| Path | What's in it |
| --- | --- |
| `crates/kasgraph-node/` | The indexer binary: ingest, detect, map, persist, POI, multi-subgraph fan-out, registry reload |
| `crates/kasgraph-rpc/` | Multi-RPC client: failover, health probes, continuous wRPC subscription + recovery |
| `crates/kasgraph-store/` | Postgres adapter: migrations, per-subgraph schemas, deployed-subgraph registry, reorg-safe unwind |
| `crates/kasgraph-detectors/` | Built-in pattern detectors (OpenSilver, KCC20, KRC-20/721) + ledgers |
| `crates/kasgraph-mapping/` | wasmtime mapping runtime for AssemblyScript handlers |
| `crates/kasgraph-poi/` | Proof of Indexing: blake2b-256 per-block hash chain + verifier |
| `crates/kasgraph-stream/` | KasStream streaming primitive |
| `sdk/` · `cli/` · `api/` · `mcp/` | `@kasgraph/{sdk,cli,api,mcp}` TypeScript packages |
| `as-mapping/` | `@kasgraph/as-mapping` AssemblyScript SDK for subgraph mappings |
| `examples/` | Six reference subgraphs (KasBonds, OpenSilver patterns, KRC-20, KRC-721, network stats, ZK proofs) |
| `docs/references/` | Reference docs: Kaspa RPC, KIP-20, KRC-20/721, BlockDAG reorgs, The Graph compatibility |
| `tests/` | Vitest workspace test suite |
| [`PLAN.md`](PLAN.md) · [`STATUS.md`](STATUS.md) | Implementation framework + live status |

## Documentation

| Topic | Doc |
| --- | --- |
| Index by Covenant ID | [`docs/references/KIP20_COVENANT_ID_QUERIES.md`](docs/references/KIP20_COVENANT_ID_QUERIES.md) |
| Reorg semantics on a BlockDAG | [`docs/references/BLOCKDAG_REORG_SEMANTICS.md`](docs/references/BLOCKDAG_REORG_SEMANTICS.md) |
| The Graph manifest compatibility | [`docs/references/THEGRAPH_REFERENCE.md`](docs/references/THEGRAPH_REFERENCE.md) |
| Native KRC-20 / KRC-721 shape | [`docs/references/KRC20_KRC721_REFERENCE.md`](docs/references/KRC20_KRC721_REFERENCE.md) |
| Kaspa RPC layer | [`docs/references/KASPA_RPC_REFERENCE.md`](docs/references/KASPA_RPC_REFERENCE.md) |

## Testing

```bash
npm run verify                # full suite: typecheck + vitest + cargo test --workspace
npm run typecheck             # tsc -b across sdk/cli/api/mcp
npx vitest run                # TypeScript tests
cargo test --workspace        # Rust tests
```

Real-Postgres integration coverage is feature-gated so the default suite needs no database. To run it against a local Postgres:

```bash
# Rust (per crate): cargo test -p kasgraph-store --features integration-pg
# TS end-to-end:    DATABASE_URL=postgres://... npx vitest run e2e-deploy-query
DATABASE_URL=postgres://kasgraph:kasgraph@127.0.0.1:5434/kasgraph npm run verify
```

## Design principles

- Core indexer in **Rust** for performance; **TypeScript** SDK + CLI for developer experience.
- Subgraph manifests compatible with **The Graph** where reasonable; schemas in standard **GraphQL SDL**.
- Storage on **PostgreSQL**; real-time updates over **WebSocket** subscriptions and the **KasStream** primitive.
- **MCP server live simultaneously with GraphQL**, not a future addition.
- **MIT licensed, public from the first commit.**

## Performance targets

These are design targets, not yet benchmarked under production load:

- Indexing latency: within **30 seconds** of chain tip at p99.
- GraphQL query latency: p95 under **200 ms**, p99 under **500 ms**.
- Streaming latency: **sub-second** from chain tip to consumer.
- Concurrent subgraphs per node: **100+**.

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first; [`PLAN.md`](PLAN.md) lists every phase's deliverables. Security reports: see [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
