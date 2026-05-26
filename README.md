# KasGraph

> The Graph for Kaspa — AI-native from day one. A subgraph-style indexing protocol with GraphQL, MCP, and streaming, redesigned around Kaspa's UTXO model, KIP-20 Covenant IDs, native KRC-20 / KRC-721, and the agent era.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Status](https://img.shields.io/badge/status-phase_2_scaffold-orange.svg)](STATUS.md)
[![KIP-20](https://img.shields.io/badge/KIP--20-covenant_ids_first_class-orange.svg)](docs/references/KIP20_COVENANT_ID_QUERIES.md)
[![MCP](https://img.shields.io/badge/MCP-first_class-blueviolet.svg)](mcp/)

**Why this exists**: Kaspa's own developer docs list structured data querying as missing. The community API is best-effort with no SLA. Kasplex covers inscription-style KRC-20 (legacy). krc721.stream covers legacy NFTs. kas.fyi is commercial RPC, not subgraph-style. With Toccata landing covenants, native KRC-20, and ZK opcodes, every serious dApp will need structured data querying — and an MCP surface so AI agents can use it without writing GraphQL.

KIP-20 Covenant IDs make this dramatically easier than EVM indexing. Stable consensus-tracked identifiers for stateful contracts mean lineage queries are first-class. No recursive UTXO walking. No event log parsing heuristics.

## Four interfaces, one data plane

```
                  +----------------------------+
                  |  Your dApp / wallet / LLM  |
                  +----------------------------+
                              │
       ┌──────────────┬───────┴─────────┬──────────────┐
       ▼              ▼                 ▼              ▼
   GraphQL          MCP            KasStream        WebSocket
  subgraph     AI natural     sub-second gRPC    push subscriptions
   queries     language       event streaming
       └──────────────┴────────┬────────┴──────────────┘
                               ▼
                       KasGraph Node (Rust)
                  ingest → detect → map → POI
                               │
                          PostgreSQL + S3
                               │
                  Rusty Kaspa RPC (multi-source, failover)
```

All four interfaces ship simultaneously. MCP is not a future addition.

## Where to go next

| If you want to… | Read… |
| --- | --- |
| Understand the implementation plan | [`PLAN.md`](PLAN.md) |
| See live status | [`STATUS.md`](STATUS.md) |
| Get the next-session queue | [`NEXT_SESSION.md`](NEXT_SESSION.md) |
| Index by Covenant ID | [`docs/references/KIP20_COVENANT_ID_QUERIES.md`](docs/references/KIP20_COVENANT_ID_QUERIES.md) |
| Reorg semantics on a BlockDAG | [`docs/references/BLOCKDAG_REORG_SEMANTICS.md`](docs/references/BLOCKDAG_REORG_SEMANTICS.md) |
| The Graph manifest compatibility | [`docs/references/THEGRAPH_REFERENCE.md`](docs/references/THEGRAPH_REFERENCE.md) |
| Native KRC-20 / KRC-721 shape | [`docs/references/KRC20_KRC721_REFERENCE.md`](docs/references/KRC20_KRC721_REFERENCE.md) |
| Kaspa RPC layer | [`docs/references/KASPA_RPC_REFERENCE.md`](docs/references/KASPA_RPC_REFERENCE.md) |
| Contribute | [`CONTRIBUTING.md`](CONTRIBUTING.md) |

## Status

Phase 2 — Core Indexer (Rust) — **scaffold landed and starting to ingest real-shaped chain events**. Workspace plumbing is in place: seven Rust crates (`kasgraph-node` / `-store` / `-mapping` / `-rpc` / `-detectors` / `-poi` / `-stream`), four TypeScript packages (`sdk` / `cli` / `api` / `mcp`), CI, vitest, cargo workspace. The current Rust path already covers multi-RPC HTTP failover, health probes, RPC audit rows, scaffold POI writes, probabilistic-vs-committed block buffering, websocket subscription bootstrap for `notifyBlockAdded` / `notifyVirtualChainChanged`, upstream-style notification envelope parsing, hash-only virtual-chain hydration, idle-bounded websocket reads, and fail-fast handling for explicit subscription rejections. Phase 0 (ecosystem outreach) is intentionally deferred — implementation runs in parallel.

See [`STATUS.md`](STATUS.md) for the live block.

## Subgraph model

Same developer experience as The Graph, with Kaspa-native primitives. Manifest example from [`PLAN.md`](PLAN.md):

```yaml
specVersion: 0.1.0
name: my-kasbonds-subgraph
dataSources:
  - name: KasBonds
    network: kaspa-mainnet
    source:
      kind: covenant_id
      ids:
        - "0xabc..."
        - pattern: "opensilver.escrow.milestone"
      startBlock: 90000000
    mapping:
      file: ./src/covenant.ts
      handlers:
        - event: CovenantLocked
          handler: handleLock
  - name: NachoNFTs
    network: kaspa-mainnet
    source:
      kind: krc721
      collection: "NACHO"
    mapping:
      file: ./src/nfts.ts
```

`kind: covenant_id` and `kind: krc721` are native Kaspa primitives. Also `kind: krc20`, `kind: address`, `kind: utxo`.

## Quick start (scaffold)

```bash
git clone https://github.com/trillskillz/KasGraph && cd KasGraph
npm install
npm run verify              # tsc -b + vitest + cargo test --workspace
```

Currently this builds the workspace and runs the scaffold smoke tests. The ingestion loop is partially real now: `kasgraph-node` can bootstrap store state, ingest JSONL notification feeds, or open a websocket notification stream, but it still reads into an in-memory batch rather than running as a forever process. The full continuous ingestion loop lands across the remaining Phase 2.3-2.8 work; the GraphQL/MCP/KasStream interfaces land in Phase 3.

## Runtime knobs already wired

These env vars are already meaningful in the current scaffold and matter for handoff work:

| Env var | Purpose |
| --- | --- |
| `KASGRAPH_DATABASE_URL` | Enables real Postgres bootstrap, migrations, POI writes, and RPC audit persistence |
| `KASGRAPH_SUBGRAPH` | Safe subgraph/schema identifier to create or reuse |
| `KASGRAPH_RPC_PRIMARY_URL` | Primary Kaspa RPC endpoint for `getBlock` / `getBlockDagInfo` |
| `KASGRAPH_RPC_BACKUP_URLS` | Comma-separated backup RPC endpoints used for failover rotation |
| `KASGRAPH_BLOCK_HASH` / `KASGRAPH_BLOCK_HASHES` | Bootstrap block(s) to fetch when not driven by a notification stream |
| `KASGRAPH_REMOVED_BLOCK_HASHES` | Removed hashes for synthetic `VirtualChainChanged` replay tests |
| `KASGRAPH_RECOVERY_BLOCK_HASHES` | Block hashes to refetch for scaffold replay windows |
| `KASGRAPH_RECOVERY_RANGE` | `from:to` DAA range for synthetic recovery requests |
| `KASGRAPH_NOTIFICATION_JSONL` | Line-delimited scaffold/live-style notifications injected directly |
| `KASGRAPH_NOTIFICATION_WS_URL` | Websocket notification source for bootstrap live reads |
| `KASGRAPH_NOTIFICATION_SOURCE_LABEL` | Logical label stamped into ingested blocks from the stream |
| `KASGRAPH_NOTIFICATION_MAX_MESSAGES` | Maximum ingested notifications from a websocket read; `0` means unbounded until idle/close |
| `KASGRAPH_NOTIFICATION_IDLE_TIMEOUT_MS` | Optional idle timeout for websocket reads so quiet streams terminate cleanly |

## Handoff note for the next agent

If you are continuing Phase 2.3, the next gaps are now very specific:

1. replace the current websocket read-into-`Vec<ChainNotification>` path with a continuous stream/loop
2. verify Kaspa's real live wire framing and subscribe acknowledgements against an actual node, not just the current JSON assumption
3. attach gap detection and replay recovery to real stream interruptions
4. add committed-state rollback semantics for deeper reorgs

The README, `STATUS.md`, and `NEXT_SESSION.md` should be updated whenever one of those moves lands so another agent can resume without spelunking through tests.

## Repo map

| Path | What's in it |
| --- | --- |
| [`PLAN.md`](PLAN.md) | Full implementation framework v2 (source of truth) |
| [`STATUS.md`](STATUS.md) | Live status block + per-phase progress |
| [`NEXT_SESSION.md`](NEXT_SESSION.md) | Autonomous work queue for the next agent run |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | How PRs land + the per-phase conventions |
| `crates/kasgraph-node/` | The indexer binary; ingestion, mapping, persistence, POI |
| `crates/kasgraph-rpc/` | Multi-RPC client with failover + BlockDAG reorg handling |
| `crates/kasgraph-store/` | Postgres adapter; per-subgraph schemas + POI checkpoints |
| `crates/kasgraph-detectors/` | Built-in pattern detectors (OpenSilver, KCC20, KRC-721, KasBonds) |
| `crates/kasgraph-mapping/` | WASM mapping runtime — TS/AssemblyScript handlers |
| `crates/kasgraph-poi/` | Proof-of-indexing — blake2b-256 per-block hash chain |
| `crates/kasgraph-stream/` | KasStream gRPC streaming primitive |
| `sdk/` | `@kasgraph/sdk` — shared TypeScript types |
| `cli/` | `@kasgraph/cli` — developer CLI |
| `api/` | `@kasgraph/api` — GraphQL gateway |
| `mcp/` | `@kasgraph/mcp` — MCP server |
| `examples/` | Reference subgraphs (KasBonds, OpenSilver patterns, KRC-20 / KRC-721, network stats, ZK proofs) |
| `docs/references/` | Phase 1 reference docs — RPC, KIP-20, KRC-20/721, BlockDAG, The Graph |
| `tests/` | Vitest workspace test suite |

## Hard constraints (from PLAN.md)

- Core indexer in **Rust** for performance.
- TypeScript SDK + CLI for developer experience.
- Subgraph manifest format compatible with **The Graph** where reasonable.
- Schemas in standard **GraphQL SDL**.
- Storage: **PostgreSQL** + materialized views.
- Real-time updates via **WebSocket** subscriptions AND **KasStream** streaming primitive.
- **MCP server live simultaneously with GraphQL** (not a future addition).
- **MIT license, public from first commit.**
- Hosted free at **kasgraph.io** during incubation.
- BigInt converted with `Number(val)` before serialization. Every API route exports `export const dynamic = 'force-dynamic'`. No em dashes anywhere.

## Performance targets

- Indexing latency: within **30 seconds** of chain tip at p99.
- GraphQL query latency: p95 under **200 ms**, p99 under **500 ms**.
- Streaming latency: **sub-second** from chain tip to consumer.
- Concurrent subgraphs per node: **100+**.
- Uptime during incubation: **99.5%** (transparent about hosted status).

## Strategic positioning

- Infrastructure, not a product.
- MIT licensed; public from first commit.
- Compounds with **KasBonds** (first dogfooding customer) and **OpenSilver** (patterns auto-detected).
- AI-native from day one — MCP is a first-class interface.
- The Graph subgraph format compatibility where reasonable — ease migration from other chains.

## Contributing

PRs welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening one. The plan in [`PLAN.md`](PLAN.md) lists every phase's deliverables — anything you ship should slot into one of those (or extend the catalog of reference subgraphs).

## License

[MIT](LICENSE).
