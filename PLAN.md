# KasGraph — Implementation Framework (v2)
## The Graph for Kaspa, AI-native from day one
## A subgraph-style indexing protocol with MCP, streaming, and multi-asset support
## For OpenClaw / davoidd execution

---

## CONTEXT FOR THE AGENT

You are building **KasGraph** -- the data layer for the post-Toccata Kaspa ecosystem. Developers define schemas, KasGraph indexes and materializes the data, both GraphQL and MCP interfaces are auto-generated. The Graph's model, redesigned natively around Kaspa's UTXO model, KIP-20 Covenant IDs, native KRC-20/KRC-721 tokens, and the AI-agent era.

**Why this exists (validated by deep research):**
1. Kaspa's own developer documentation lists structured data querying as missing. The community API is "best-effort with no SLA."
2. Kasplex covers inscription-style KRC-20 (legacy). KRC-721 indexing exists at krc721.stream but is fragmented and limited to legacy NFTs.
3. kas.fyi is commercial RPC, not subgraph-style.
4. The Graph, Goldsky, Chainbase, SubQuery, Ormi all support 70+ chains. Kaspa is on none of them.
5. With Toccata landing covenants, native KRC-20, and ZK opcodes in 2-3 weeks, every serious dApp will need structured data querying.
6. The Graph shipped Subgraph MCP in 2025 -- LLMs query 15,000+ subgraphs in natural language. Kaspa has zero equivalent. The agent era is here and Kaspa has no data primitive for it.

**KIP-20 Covenant IDs make this dramatically easier than EVM indexing.** Stable consensus-tracked identifiers for stateful contracts mean lineage queries are first-class. No recursive UTXO walking. No event log parsing heuristics.

**Strategic positioning:**
- Infrastructure, not a product
- MIT licensed, public from first commit
- Free hosted service during incubation (kasgraph.io). Sustainability model documented but not executed in v1.
- Compounds with KasBonds (first dogfooding customer) and OpenSilver (patterns auto-detected)
- AI-native from day one. MCP is a first-class interface, not bolted on later.
- The Graph subgraph manifest format compatible where reasonable -- ease migration from other chains.

---

## EXISTING ECOSYSTEM (DO NOT REINVENT)

| Project | Role | Relationship to KasGraph |
| --- | --- | --- |
| Rusty Kaspa RPC | Source of truth for chain data | Primary data source. KasGraph subscribes to it. |
| Kaspa Community API | REST endpoint for basic queries | Complementary. KasGraph adds structured/typed queries. |
| Kas.fyi Developer Platform | Commercial RPC + REST API | Adjacent. KasGraph is open source + GraphQL + MCP + subgraph model. |
| Kasplex Indexer | KRC-20 inscription-style indexer | Legacy era. KasGraph indexes native KRC-20 post-Toccata + covenants. |
| krc721.stream | KRC-721 NFT indexer | Legacy era. KasGraph indexes NFTs natively with covenant patterns. |
| KaspaAPI (PowerShell) | Limited PowerShell tooling | Not competition. Different audience. |
| Kaspa Graph Inspector | DAG visualizer | Complementary. KasGraph could expose data the Inspector uses. |
| OpenSilver | Covenant pattern library | First-class integration. Patterns auto-detected and indexed. |
| KasBonds | Bond protocol | First customer. Migrates from custom indexing to KasGraph subgraph. |
| Igra Labs | EVM rollup on Kaspa | Cross-layer indexing target (Phase 9 roadmap). |
| Kasplex L2 (zkEVM) | EVM-compatible L2 | Cross-layer indexing target (Phase 9 roadmap). |
| Sparkle (Anton's research) | CDAG + ZK architecture | vProgs-adjacent. Forward compatibility considered. |
| Hans Moog vProgs PRs | Long-term off-chain execution framework | Phase 9 roadmap target for hybrid L1+off-chain subgraphs. |
| The Graph + Subgraph MCP | Reference architecture + AI surface | Format compatibility goal. Migration path advertised. |

**Hard rule: coordinate with Kaspa Foundation, Kasplex team, kas.fyi team, and KRC-721 indexer maintainers in Phase 0 before public launch.**

---

## HARD CONSTRAINTS (NON-NEGOTIABLE)

- Core indexer in Rust for performance
- TypeScript SDK + CLI for developer experience
- Subgraph manifest format compatible with The Graph where reasonable
- Schemas defined in standard GraphQL SDL
- Storage: PostgreSQL with appropriate indexes + materialized views
- Real-time updates via WebSocket subscriptions AND streaming primitive (KasStream)
- MCP server live simultaneously with GraphQL API (not a future addition)
- Raw SQL via `(db as any).$client.execute()` for any Next.js dashboard work
- No em dashes anywhere
- MIT license, public from first commit
- Hosted at kasgraph.io free during incubation
- Every API route exports `export const dynamic = 'force-dynamic'`
- BigInt converted with `Number(val)` before serialization

**Explicit performance targets (matched against Goldsky/Ormi):**
- Indexing latency: within 30 seconds of chain tip at p99
- GraphQL query latency: p95 under 200ms, p99 under 500ms
- Streaming latency: sub-second from chain tip to consumer
- Concurrent subgraphs supported per node: 100+
- Uptime target during incubation: 99.5% (transparent about hosted nature)

---

## ARCHITECTURE OVERVIEW

```
+--------------------------------------------------+
|  Consumers                                        |
|  dApps · Wallets · Explorers · AI Agents (MCP)   |
+--------------------------------------------------+
              |
              v
+--------------------------------------------------+
|  KasGraph Interface Layer                         |
|  - GraphQL API (subgraph queries)                |
|  - MCP Server (AI natural language)              |
|  - KasStream (real-time streaming primitive)     |
|  - WebSocket subscriptions                       |
+--------------------------------------------------+
              |
              v
+--------------------------------------------------+
|  KasGraph Node (Rust)                             |
|  - Block ingestion (multi-RPC failover)          |
|  - Event mapping execution (WASM runtime)        |
|  - KIP-20 Covenant ID lineage tracker            |
|  - OpenSilver pattern auto-detector              |
|  - KRC-20 native asset detector                  |
|  - KRC-721 NFT detector                          |
|  - ZK proof + witness data indexer               |
|  - Proof-of-indexing (POI) generator             |
|  - BlockDAG-aware reorg handler                  |
+--------------------------------------------------+
              |
              v
+--------------------------------------------------+
|  PostgreSQL + Materialized Views                  |
|  + S3 (or compatible) for witness data            |
+--------------------------------------------------+
              |
              v
+--------------------------------------------------+
|  Data Sources                                    |
|  - Rusty Kaspa RPC (primary)                     |
|  - Backup RPC (failover)                         |
|  - Future: Igra L2 RPC, Kasplex L2 RPC           |
|  - Future: vProg execution traces                |
+--------------------------------------------------+
```

**Core components:**

1. **KasGraph Node** -- Rust binary handling all ingestion, mapping, and persistence
2. **KasGraph Interface Layer** -- GraphQL + MCP + KasStream + WebSocket, all backed by the same data
3. **KasGraph CLI + SDK** -- TypeScript developer tools
4. **KasGraph Hosted Service** -- kasgraph.io, free during incubation

---

## SUBGRAPH MODEL

Identical developer experience to The Graph, with Kaspa-native primitives.

### Manifest

```yaml
specVersion: 0.1.0
name: my-clawdmkt-subgraph
description: Index all KasBonds activity
schema:
  file: ./schema.graphql
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
      kind: typescript
      file: ./src/covenant.ts
      entities:
        - Bond
        - Verification
        - SlashingEvent
      handlers:
        - event: CovenantLocked
          handler: handleLock
        - event: CovenantReleased
          handler: handleRelease
        - event: CovenantSlashed
          handler: handleSlash
  - name: NachoNFTs
    network: kaspa-mainnet
    source:
      kind: krc721
      collection: "NACHO"
      startBlock: 89000000
    mapping:
      file: ./src/nfts.ts
      entities:
        - NFT
        - Transfer
        - Holder
```

Notice `kind: covenant_id` and `kind: krc721` -- native Kaspa primitives. Also `kind: krc20`, `kind: address`, `kind: utxo` for other use cases.

---

## PHASE 0 — ECOSYSTEM COORDINATION

**Task 0.1 — Reach out** to:
- Kaspa Foundation
- Kasplex team
- kas.fyi team
- krc721.stream maintainers
- Michael Sutton, Hans Moog (forward-compatibility check)
- Wallet teams (KaspaCom, Kasware, Tangem)
- Igra Labs (cross-layer indexing future)

**Task 0.2 — Output `ECOSYSTEM_COORDINATION.md`**

**Output of Phase 0:** Documented coordination state. Proceed once at least Kaspa Foundation or Kasplex acknowledges the work.

---

## PHASE 1 — RECONNAISSANCE

**Task 1.1 — Study The Graph deeply**
- graph-node source code
- Subgraph manifest format
- WASM mapping runtime
- **Subgraph MCP architecture (CRITICAL -- match or beat this)**
- Substreams architecture (for streaming primitive)

**Task 1.2 — Study Kaspa RPC + WireProto**
- All RPC methods available
- Block subscription patterns
- **BlockDAG-specific reorg semantics (KIP-20 confirmation finality)**
- KIP-20 Covenant ID exposure
- KRC-20 native (Toccata) data shape
- KRC-721 inscription data shape

**Task 1.3 — Study Kasplex Indexer + krc721.stream**
- Open source code for proven patterns
- What works at Kaspa scale
- What KasGraph should improve

**Task 1.4 — Output reference docs**
- `THEGRAPH_REFERENCE.md`
- `KASPA_RPC_REFERENCE.md`
- `KIP20_COVENANT_ID_QUERIES.md`
- `KRC20_KRC721_REFERENCE.md`
- `BLOCKDAG_REORG_SEMANTICS.md`

**Output of Phase 1:** Five reference docs. **Stop and confirm before Phase 2.**

---

## PHASE 2 — CORE INDEXER (RUST)

**Task 2.1 — Project scaffold**
```
kasgraph/
├── crates/
│   ├── kasgraph-node/         # Rust indexer binary
│   ├── kasgraph-store/        # Postgres adapter
│   ├── kasgraph-mapping/      # WASM mapping runtime
│   ├── kasgraph-rpc/          # Multi-RPC client with failover
│   ├── kasgraph-detectors/    # Pattern detectors (OpenSilver, KRC20, KRC721)
│   ├── kasgraph-poi/          # Proof-of-indexing
│   └── kasgraph-stream/       # KasStream streaming primitive
├── sdk/                       # TypeScript SDK
├── cli/                       # kasgraph CLI
├── api/                       # GraphQL gateway (Node.js)
├── mcp/                       # MCP server (Node.js)
├── examples/                  # Reference subgraphs
└── docs/                      # Documentation
```

**Task 2.2 — Block ingestion with multi-RPC failover**
- Primary RPC + N backup RPCs
- Automatic failover on timeout or error
- Health checks against each source
- Audit log of which source served which block

**Task 2.3 — BlockDAG-aware reorg handling**
- Use KIP-20 confirmation finality for confident commits
- Buffer probabilistic blocks separately from confirmed
- Replay-safe state transitions

**Task 2.4 — KIP-20 Covenant ID lineage tracker**
- First-class entity tracked from genesis
- For each Covenant ID, materialize parent UTXO → current UTXO lineage
- Expose `covenantId` as a first-class field on every UTXO entity

**Task 2.5 — Pattern detectors (built-in)**

```rust
// crates/kasgraph-detectors/src/lib.rs

pub enum DetectorKind {
    OpenSilverVault,
    OpenSilverEscrow,
    OpenSilverMultisig,
    OpenSilverVesting,
    OpenSilverStreamingPayment,
    OpenSilverAtomicSwap,
    OpenSilverDeadMansSwitch,
    OpenSilverSocialRecovery,
    OpenSilverFreelancePayroll,
    KCC20Asset,        // native KRC-20 post-Toccata
    KCC20Controller,
    KRC721Collection,  // legacy NFT inscriptions
    KRC721NFT,
    KasBondsBond,      // detects KasBonds activity natively
}
```

Each detector emits typed events that subgraphs subscribe to. Apps don't write detection code -- they subscribe to typed events.

**Task 2.6 — WASM mapping runtime**
- TypeScript mappings compile to WASM via AssemblyScript
- Sandboxed execution per block
- Strict deterministic execution
- Subgraph manifest compatible with The Graph format where reasonable (for migration ease)

**Task 2.7 — ZK proof + witness data indexing**
- Detect Groth16 proofs in covenant spends (per KIP-16)
- Store proofs in primary storage, witness data in object storage (S3 or compatible)
- Index proof verification status as queryable entity
- Foundation for vProgs era

**Task 2.8 — Proof-of-indexing (POI)**
- Per-block hash of indexed state
- Stored alongside indexed data
- Allows third parties to verify indexer correctness
- Foundation for future decentralization

**Output of Phase 2:** Working indexer node. Subscribes to TN12, processes blocks, runs mappings, writes to Postgres with POI checkpoints.

---

## PHASE 3 — INTERFACE LAYER (GRAPHQL + MCP + STREAMING)

All three interfaces ship simultaneously. MCP is not a future addition.

### Task 3.1 — GraphQL API

- Auto-generate Postgres schema from subgraph's `schema.graphql`
- Auto-generate resolvers
- Auto-handle pagination, filtering, ordering, derived fields
- Block-specific queries: `block: { number: 123 }` for historical state
- Cross-subgraph federation

### Task 3.2 — MCP Server (CRITICAL)

This is the AI-native interface. Match or beat The Graph's Subgraph MCP.

```typescript
// MCP tools exposed
- list_subgraphs(keyword?)             // find available subgraphs
- get_schema(subgraph_id)              // GraphQL schema for natural language reasoning
- execute_query(subgraph_id, query)    // run a GraphQL query
- search_by_pattern(pattern_name)      // find UTXOs matching OpenSilver pattern
- get_covenant_lineage(covenant_id)    // KIP-20 lineage walking
- get_address_activity(address)        // historical activity for any address
- find_subgraphs_for_address(address)  // which subgraphs index this address
- query_natural_language(prompt)       // optional: pre-built NL→GraphQL helper
```

Host at `mcp.kasgraph.io`. Publish Claude Desktop, Cursor, Claude Code config snippets. Document how OpenClaw agents integrate.

This makes every subgraph on KasGraph instantly queryable by Claude, Cursor, agents -- without writing GraphQL.

### Task 3.3 — KasStream (streaming primitive)

Substreams-style architecture for sub-second latency consumers.

- Block-by-block event stream over gRPC
- Consumers subscribe to specific data sources (Covenant IDs, OpenSilver patterns, KRC-20 tickers, addresses)
- Backpressure-aware
- Used by latency-sensitive applications (trading dashboards, real-time wallets, MEV-style scanners)

### Task 3.4 — WebSocket subscriptions

GraphQL-native subscriptions for everyday use cases:
- Watch for new entities matching a filter
- Watch for entity updates
- Watch for specific Covenant IDs

**Output of Phase 3:** GraphQL + MCP + KasStream + WebSocket all live. Same data, four interfaces.

---

## PHASE 4 — DEVELOPER CLI + SDK

```bash
kasgraph init <name>              # scaffold a new subgraph
kasgraph init --from-thegraph     # migrate from The Graph subgraph
kasgraph codegen                  # generate types from schema.graphql
kasgraph build                    # compile mappings to WASM
kasgraph deploy --node <url>      # deploy to hosted node
kasgraph status <subgraph>        # check indexing status
kasgraph logs <subgraph>          # tail mapping logs
kasgraph remove <subgraph>        # remove a deployed subgraph
kasgraph mcp-config               # generate MCP config for Claude/Cursor/OpenClaw
```

**Task 4.1 — SDK package**
- `@kasgraph/cli` published to npm
- `@kasgraph/types` for shared TypeScript types
- `@kasgraph/migrate` for The Graph → KasGraph migration

**Task 4.2 — IDE integration**
- VS Code extension for `subgraph.yaml` validation
- Schema-aware autocomplete in mapping files

**Output of Phase 4:** CLI live on npm. Onboarding to "first subgraph deployed" under 10 minutes. The Graph migration path documented.

---

## PHASE 5 — HOSTED SERVICE (KASGRAPH.IO)

**Task 5.1 — Multi-tenant infrastructure**
- KasGraph Node + GraphQL + MCP + KasStream deployed to production
- Multi-tenant Postgres with per-subgraph schemas
- Resource limits per subgraph (CPU, memory, query rate)

**Task 5.2 — Developer portal**
- Web dashboard at kasgraph.io
- Sign in with KAS wallet
- Deploy subgraphs through web UI
- View indexing status, query stats, error logs
- Public subgraph explorer
- MCP config generator (one-click Claude Desktop / Cursor setup)

**Task 5.3 — Reliability + observability**
- Status page (publicly visible uptime)
- Multi-RPC failover monitoring
- POI verification dashboard
- Public per-subgraph health metrics

**Task 5.4 — Rate limits and SLA**
- Free tier: 100k queries/month, basic SLA
- Pro tier: documented but not enforced in v1 (sustainability model)
- Hosted is free during incubation
- Document target uptime + latency

**Output of Phase 5:** kasgraph.io live with all four interfaces (GraphQL, MCP, KasStream, WebSocket).

---

## PHASE 6 — REFERENCE SUBGRAPHS

Build canonical reference subgraphs that demonstrate the platform AND provide immediate value.

### Reference 6.1 — KasBonds
Index all KasBonds activity. Replaces KasBonds' custom indexing.

### Reference 6.2 — OpenSilver Patterns
Index every UTXO matching a known OpenSilver pattern. Powers "find all OpenSilver vaults" queries.

### Reference 6.3 — KRC-20 Tokens (native, post-Toccata)
All native KRC-20 deployments, transfers, holders. Replaces Kasplex for the native era.

### Reference 6.4 — KRC-721 NFTs
All NFT collections, mints, transfers, holders. Complements krc721.stream with covenant-aware indexing.

### Reference 6.5 — Network Stats
Block production, transaction volume, address activity, fees.

### Reference 6.6 — ZK Proofs and Witnesses
All on-chain ZK proofs (per KIP-16), with witness data. Foundation for vProgs queries.

**Output of Phase 6:** Six reference subgraphs deployed at kasgraph.io.

---

## PHASE 7 — INTEGRATIONS

**Task 7.1 — KasBonds migration**
Update KasBonds to query its data via KasGraph subgraph instead of custom indexing. Document the migration as a case study.

**Task 7.2 — OpenSilver integration**
OpenSilver SDK auto-detects KasGraph and exposes pattern-aware queries. Pattern docs link to corresponding KasGraph queries.

**Task 7.3 — Wallet integration paths**
Integration guides for KaspaCom Wallet, Kasware, Tangem. Demonstrate token balances, transaction history, covenant state queries.

**Task 7.4 — Block explorer integration**
Outreach to kaspa.stream, explorer.kaspa.org. KasGraph as the enrichment layer for raw chain data.

**Task 7.5 — AI agent integration**
Reference integrations for OpenClaw, Claude Code, Cursor showing MCP-driven natural language queries.

**Output of Phase 7:** KasBonds running on KasGraph. OpenSilver integrated. Wallet/explorer/agent integration paths documented.

---

## PHASE 8 — MAINNET LAUNCH (TOCCATA WINDOW)

**Task 8.1 — Mainnet readiness**
- Audit core indexer for correctness
- Stress test against TN12 with synthetic load
- Confirm latency targets met (indexing < 30s of tip, query p95 < 200ms)

**Task 8.2 — Toccata-day deploy**
- Switch hosted endpoint to mainnet RPC on Toccata activation
- Deploy all six reference subgraphs to mainnet
- Confirm KasBonds queries serving from KasGraph on mainnet
- Confirm MCP server returns mainnet data

**Task 8.3 — Public launch**
- Submit PR to https://github.com/aspectron/awesome-kaspa
- Submit PR to kaspa.org/build adding KasGraph
- Update KasBonds and OpenSilver docs to reference KasGraph
- Publish MCP integration guides for Claude Desktop, Cursor, Claude Code, OpenClaw
- Technical blog post: "The Data Layer for the Kaspa Covenant Era"
- X thread timed to Toccata activation

**Output of Phase 8:** Live on mainnet. Reference subgraphs serving real queries. MCP integrations published. Ecosystem outreach complete.

---

## PHASE 9 — POST-LAUNCH ROADMAP (DOCUMENTED, NOT EXECUTED IN V1)

Document the future explicitly without committing dates.

### 9.1 — Cross-Layer Indexing
- Index Igra Labs EVM rollup data
- Index Kasplex L2 (zkEVM) data
- Cross-layer subgraphs that span Kaspa L1 + L2 in single queries
- This is the biggest growth lever post-launch

### 9.2 — vProgs Support
- Index off-chain vProg execution traces alongside L1 covenant state
- Subgraphs that span L1 + off-chain proofs natively
- Forward-compatibility designed in from Phase 2.7 (witness data storage)

### 9.3 — Decentralization
- Multi-indexer support
- Payment for queries
- KAS staking model for decentralized indexer network
- Avoid The Graph's hosted-then-deprecation cycle: be transparent about hosted vs decentralized roadmap from start

### 9.4 — Analytics Primitives
- Time-series queries
- Aggregations
- Materialized rollups (daily, weekly, monthly)
- Built-in for common patterns (token volume, DAU/MAU, holder distribution)

### 9.5 — Advanced AI Surface
- Pre-built natural language → GraphQL templates per subgraph
- AI-generated dashboards from subgraph data
- Agent action triggers (notify when X happens) -- relevant for KasBonds + OpenClaw

### 9.6 — Sustainability Model
- Document path from free hosted to sustainable
- Options: KAS-denominated pay-per-query, subgraph hosting subscription, enterprise SLA tier
- Decision deferred to post-launch with community input

**Output of Phase 9:** `ROADMAP.md` documenting the path forward.

---

## STATUS REPORTING

After each phase:
```
PHASE_N_STATUS: COMPLETE | BLOCKED | IN_PROGRESS
COMPONENTS_LIVE: <list>
TESTNET_INDEXED_BLOCKS: <count>
SUBGRAPHS_DEPLOYED: <count>
QUERY_LATENCY_P95: <ms>
MCP_TOOLS_LIVE: <count>
BLOCKERS: <any, or NONE>
NEXT_PHASE: <phase>
```

End each successful run:
```
TASK_STATUS: COMPLETE
COMMIT: <hash>
DEPLOYED: <url or N/A>
QUERIES_SERVED: <count>
```

---

## RULES OF ENGAGEMENT

1. **Phase 0 is a hard gate.** Coordinate with Kaspa Foundation, Kasplex, kas.fyi, krc721.stream maintainers before public launch.
2. **MCP is core, not optional.** Ships in Phase 3 simultaneously with GraphQL. The Graph already has Subgraph MCP. We do not launch without it.
3. **Performance is a feature.** Hit the explicit targets in the constraints. Cut features rather than miss them.
4. **The Graph subgraph format compatibility where reasonable.** Document compatibility gaps explicitly. Migration paths for both directions.
5. **KIP-20 Covenant IDs are first-class.** Every UTXO entity exposes its Covenant ID. Subgraphs subscribe to Covenant IDs directly.
6. **OpenSilver pattern detection is built-in.** Subgraphs get pattern-aware events without writing detection code.
7. **KRC-20 + KRC-721 are first-class.** Native asset and NFT support out of the box, not as community add-ons.
8. **Multi-RPC failover from day one.** Single RPC source is a single point of failure. Unacceptable for infrastructure.
9. **Proof-of-indexing checkpoints from day one.** Foundation for future decentralization and immediate verification capability.
10. **Free hosting during incubation. Sustainability documented, not executed in v1.**
11. **Open source from day zero.** MIT license. Public from first commit.
12. **The Graph's hosted-then-deprecation cycle is documented and avoided.** Transparent about hosted vs decentralized roadmap from the start.
13. **Race the launch window.** Toccata activation is the marketing event. Ship reference subgraphs and MCP on activation day.
14. **The data layer must outlast individual apps.** KasGraph survives the loss of any single subgraph.
15. **Forward-compatibility with vProgs and L2s designed in from Phase 2.** Avoid major refactors when those primitives land.

Begin with Phase 0. Toccata activation is approximately two weeks away.
