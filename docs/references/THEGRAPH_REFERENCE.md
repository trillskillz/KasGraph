# The Graph reference

Status: **deep-dive draft landed**. This doc captures where KasGraph is deliberately compatible with The Graph, where it diverges because Kaspa is not an EVM chain, and what `kasgraph init --from-thegraph` should eventually rewrite.

## Scope

This is not a generic overview of The Graph.

It focuses on four things that matter directly to KasGraph:

- manifest compatibility
- mapping runtime compatibility
- CLI and developer-workflow compatibility
- MCP surface parity

## Source of truth

Primary upstream references used here:

- `graphprotocol/graph-tooling` CLI README
- The Graph docs: AssemblyScript mappings
- The Graph docs: Subgraph MCP introduction
- The Graph docs: Subgraph MCP Cursor integration / tool overview
- KasGraph local sources: `PLAN.md`, `sdk/src/index.ts`, `mcp/src/index.ts`, `cli/src/cli.ts`, `crates/kasgraph-mapping/src/lib.rs`

When this doc says "compatible", read it as one of:

- already represented in KasGraph's local types or scaffolds, or
- explicitly intended by `PLAN.md`

Anything else should be treated as future work, not as already shipped.

## High-level positioning

The Graph's model is:

- manifest-driven indexing
- GraphQL schema as the durable data contract
- mappings compiled to WASM from AssemblyScript
- CLI-centered developer workflow
- query surface primarily through GraphQL
- now also an MCP surface for AI clients

KasGraph keeps that overall mental model because it is proven and familiar.

But it swaps the chain primitive underneath:

- **The Graph default mental model:** contracts, events, logs, addresses, deployments
- **KasGraph mental model:** UTXOs, covenant IDs, selected-chain transitions, native KRC-20/KRC-721 patterns, address activity, and BlockDAG recovery

So the rule is:

- preserve the **developer ergonomics** where reasonable
- replace the **chain semantics** where necessary

## Compatibility summary

| Area | The Graph | KasGraph stance |
| --- | --- | --- |
| Manifest file | `subgraph.yaml`-style declarative manifest | Compatible in spirit and mostly in shape |
| GraphQL schema | Core source of entity types | Same |
| Mapping language | AssemblyScript compiled to WASM | TypeScript / AssemblyScript to WASM, deterministic runtime planned |
| Data source identity | usually EVM contract-centric | Kaspa-native source kinds |
| Trigger model | events / calls / blocks | typed Kaspa-native handlers fed by detectors + RPC ingestion |
| CLI workflow | `init`, `codegen`, `build`, `deploy`, `remove` | same mental model, Kaspa-specific implementation |
| Query surface | GraphQL | GraphQL + MCP + KasStream + WebSocket |
| MCP | schema lookup, query, discovery across deployments | first-class parity target, plus Kaspa-native tools |

## Manifest compatibility

## What KasGraph should keep verbatim or nearly verbatim

These fields are already represented in the local SDK or in `PLAN.md` and are the safest compatibility layer to preserve:

### Top-level fields

- `specVersion`
- `name`
- `description`
- `schema.file`
- `dataSources[]`

KasGraph's `sdk/src/index.ts` already models:

- `specVersion: string`
- `name: string`
- optional `description`
- `schema: { file: string }`
- `dataSources: SubgraphDataSource[]`

### Mapping block

KasGraph already mirrors this shape closely:

- `mapping.kind`
- `mapping.file`
- `mapping.entities`
- `mapping.handlers`

The local SDK currently pins:

- `mapping.kind: 'typescript'`
- `file: string`
- `entities: string[]`
- `handlers: Array<{ event: string; handler: string }>`

That is intentionally Graph-like: a declarative list of handlers mapped to named events.

### Schema-driven codegen workflow

The Graph CLI uses:

- `graph codegen`
- `graph build`

to generate entity classes and typed event bindings before compiling mappings to WASM.

KasGraph's CLI scaffold preserves the same muscle memory:

- `kasgraph codegen`
- `kasgraph build`

This is a good compatibility choice because it lowers migration friction even if the generated types differ internally.

## Where KasGraph diverges intentionally

### 1. Data-source kinds are Kaspa-native

The biggest intentional break is the source model.

KasGraph's SDK currently defines these data-source kinds:

- `covenant_id`
- `krc20`
- `krc721`
- `address`
- `utxo`

This is the exact opposite of pretending Kaspa is EVM-like.

Instead of contract + ABI being the universal source primitive, KasGraph treats these as first-class:

- covenant instances and covenant patterns
- native token domains
- NFT / inscription domains
- address activity
- direct UTXO tracking

### 2. `kind` lives as a KasGraph-native source discriminator

In the local SDK, each data source has:

- `kind`
- `source: Record<string, unknown>`

That gives KasGraph freedom to support source-specific selectors like:

- `ids` for `covenant_id`
- `pattern` for OpenSilver detector-driven matching
- ticker / collection selectors for `krc20` and `krc721`
- raw address selectors
- literal UTXO ids

This is the main manifest-level deviation from The Graph.

### 3. Start block is still useful, but means "start at this Kaspa chain position"

`PLAN.md` already shows `startBlock` in the manifest examples.

KasGraph should keep the field because migrators and developers expect it, but the semantics become Kaspa-specific:

- selected-chain oriented start point
- potentially interpreted against DAA / finalized-chain indexing policy internally

The field name can stay Graph-like even if the runtime meaning is Kaspa-aware.

### 4. Handler triggers are detector-backed, not ABI-event-backed

The Graph mapping model expects handler names that correspond to chain-derived event types.

KasGraph's runtime should preserve the handler declaration shape, but the producer changes:

- **The Graph:** ABI-decoded events / calls / blocks
- **KasGraph:** detector and indexer-produced typed events, backed by RPC blocks, covenant lineage, pattern recognition, and token decoders

So this manifest entry remains familiar:

```yaml
handlers:
  - event: CovenantLocked
    handler: handleLock
```

but `CovenantLocked` is not an EVM log signature. It is a KasGraph-defined typed event emitted by ingestion + detection layers.

## Manifest field matrix

| Manifest concept | The Graph | KasGraph |
| --- | --- | --- |
| `specVersion` | keep | keep |
| `schema.file` | keep | keep |
| `dataSources[].name` | keep | keep |
| `dataSources[].network` | keep idea, different enum values | keep with Kaspa network ids |
| `source.kind` | usually chain-specific contract source kinds | replace with `covenant_id | krc20 | krc721 | address | utxo` |
| source address / ABI | central | not universal; often replaced by ids, patterns, addresses, or UTXOs |
| `mapping.kind` | AssemblyScript / WASM toolchain-oriented | keep developer-facing `typescript` shape |
| `mapping.file` | keep | keep |
| `entities` | keep | keep |
| handler declarations | keep shape | keep shape, Kaspa-native event names |

## Mapping runtime compatibility

## What The Graph does

The Graph's mapping docs describe:

- mappings written in AssemblyScript
- one exported function per handler declared in the manifest
- typed access to entity classes generated from the schema
- typed access to chain-derived bindings generated from ABIs
- `save()` / `load()`-style entity persistence through generated classes and host imports

That gives developers a very recognizable programming model:

- receive typed event input
- load or create entities
- mutate fields
- save

## What KasGraph should preserve

KasGraph should preserve these invariants as closely as practical:

1. **one exported handler function per manifest handler**
2. **schema-driven generated entity types**
3. **deterministic host functions only**
4. **no ambient network access from mappings**
5. **block-context object available to mappings**

The local `kasgraph-mapping` crate already points in this direction:

- `MappingRuntime::new(wasm_bytes)`
- `MappingRuntime::dispatch(event)`
- `MappingEvent { block_daa_score, block_hash, payload, handler }`

That is the right scaffold because it cleanly separates:

- the host runtime
- the chain ingestion layer
- the mapping handler ABI

## What KasGraph cannot mirror 1:1

### ABI-generated contract bindings

The Graph codegen model heavily depends on contract ABIs.

KasGraph should not force a fake ABI abstraction onto Kaspa.

Instead, codegen should primarily generate:

- entity classes from `schema.graphql`
- typed handler payload shapes from KasGraph event definitions
- helper types for covenant lineage, addresses, token events, and UTXO transitions

### Event parameter model

The Graph handlers commonly receive `event.params.*`, `event.transaction.*`, `event.block.*`.

KasGraph can imitate the ergonomics, but the payload content should be Kaspa-native, for example:

- covenant id
- consumed UTXOs
- produced UTXOs
- selected-chain inclusion metadata
- DAA score
- detector-kind / pattern-name
- token transfer payloads

### Calls and traces

The Graph supports patterns that assume smart-contract call traces or explicit EVM call handlers.

KasGraph should not claim parity there until there is a real Kaspa-native equivalent.

For now, the honest model is:

- strong parity on declarative data sources and deterministic mapping handlers
- different trigger semantics because Kaspa's execution model is different

## CLI workflow compatibility

The Graph CLI README lists these core commands:

- `graph init`
- `graph create`
- `graph remove`
- `graph codegen`
- `graph build`
- `graph deploy`
- `graph auth`
- `graph local`
- `graph test`
- `graph add`
- `graph publish`

KasGraph's CLI scaffold currently advertises:

- `kasgraph init <name>`
- `kasgraph init --from-thegraph`
- `kasgraph codegen`
- `kasgraph build`
- `kasgraph deploy --node <url>`
- `kasgraph status <subgraph>`
- `kasgraph logs <subgraph>`
- `kasgraph remove <subgraph>`
- `kasgraph mcp-config`

## Compatibility judgment

KasGraph is not trying to be command-for-command identical.

It is trying to preserve the **workflow shape**:

- scaffold
- generate types
- build mappings
- deploy
- inspect status/logs
- remove

That is the right level of compatibility.

## Commands KasGraph should eventually support well for migration ease

These are the commands that matter most for a former Graph developer:

- `kasgraph init`
- `kasgraph init --from-thegraph <path>`
- `kasgraph codegen`
- `kasgraph build`
- `kasgraph deploy`
- `kasgraph remove`

Everything else can differ as long as the core loop feels familiar.

## MCP surface parity

## What The Graph's Subgraph MCP exposes

From The Graph's MCP docs, the server supports a tool surface centered around:

- schema retrieval by deployment ID
- schema retrieval by subgraph ID
- schema retrieval by IPFS hash
- query execution by deployment ID
- query execution by subgraph ID
- discovery of top subgraph deployments for a contract on a chain
- natural-language query workflows built on top of the schema + query tools
- query-volume retrieval for subgraph deployments

The introduction doc describes the product-level capabilities as:

- search relevant subgraphs
- inspect GraphQL schemas
- run queries against deployments
- discover top deployments by keyword or contract address
- retrieve 30-day query volumes
- ask natural-language questions without hand-writing GraphQL

## What KasGraph already plans locally

KasGraph's `mcp/src/index.ts` defines these eight tool names:

- `list_subgraphs`
- `get_schema`
- `execute_query`
- `search_by_pattern`
- `get_covenant_lineage`
- `get_address_activity`
- `find_subgraphs_for_address`
- `query_natural_language`

## Parity analysis

### Direct parity

| The Graph MCP concept | KasGraph equivalent |
| --- | --- |
| search subgraphs | `list_subgraphs` |
| get schema | `get_schema` |
| execute query | `execute_query` |
| NL query helper | `query_natural_language` |

### KasGraph-native extensions

These are not just parity features. They are why KasGraph can be better for Kaspa:

- `search_by_pattern`
- `get_covenant_lineage`
- `get_address_activity`
- `find_subgraphs_for_address`

Those tools expose chain-native affordances that The Graph's generic cross-chain MCP does not center by default.

### Not yet mirrored from The Graph

Two The Graph MCP capabilities are not yet explicitly named in KasGraph's current local tool list:

- retrieval by deployment ID / IPFS hash as first-class identifiers
- query-volume / popularity metadata for deployments

KasGraph may not need the exact same identifiers if its deployment model differs, but this gap should be documented and revisited.

## Recommended MCP principle

KasGraph should match The Graph on the generic AI workflow:

1. discover the right dataset
2. inspect the schema
3. run a query
4. support NL prompting over the same data plane

Then it should exceed The Graph on Kaspa-specific reasoning:

- lineage
- pattern matching
- address-centric discovery
- UTXO-native history

## Migration path: `kasgraph init --from-thegraph`

The local CLI already reserves this command shape, which is the right call.

## What the migrator should do

For a Graph-style subgraph, the migrator should:

1. read the existing manifest
2. preserve top-level metadata where possible
3. preserve `schema.file`
4. preserve mapping file locations where possible
5. rewrite data-source definitions into KasGraph-native source kinds
6. flag unsupported EVM-only concepts explicitly
7. emit a report of manual follow-up items

## Safe automatic rewrites

These are good candidates for mechanical migration:

- `specVersion`
- `name`
- `description`
- `schema.file`
- mapping file paths
- `entities`
- handler names where a KasGraph event analogue is known

## Rewrite examples

### Contract-centric Graph source → covenant pattern source

A Graph-style source that means "index one protocol deployment" may map to:

- `kind: covenant_id` with literal ids, or
- `kind: covenant_id` with a `pattern:` selector if the protocol is recognized by a detector

### Token contract source → `krc20`

An ERC-20-oriented subgraph concept should not become a fake contract abstraction. It should become a native token source when the target protocol really is native KRC-20.

### NFT contract source → `krc721`

Likewise, NFT-centric manifests should migrate to the KRC-721 / inscription-aware source kind when appropriate.

### Address watchers

Some Graph subgraphs are really account-activity views. Those should become `kind: address` sources.

## What the migrator must reject or mark manual

These should be treated as explicit manual follow-up items, not silently guessed:

- ABI-only call handlers with no Kaspa-native equivalent
- event signatures that depend on EVM logs
- dynamic data sources that assume contract-factory semantics without a covenant analogue
- manifest features that depend on Ethereum block receipts, transaction traces, or log topics

## Suggested migration report shape

`kasgraph init --from-thegraph` should emit a summary like:

- copied fields unchanged
- rewritten fields
- dropped fields with reason
- handlers requiring manual rewrite
- recommended KasGraph source kind per original data source

That makes the migration auditable instead of magical.

## Where KasGraph should be stricter than The Graph

KasGraph should be opinionated in a few places:

- source kinds must be explicit and Kaspa-native
- mappings must be deterministic only
- cross-subgraph / cross-pattern lineage should be first-class, not an afterthought
- BlockDAG recovery semantics should be handled by the runtime, not hidden in mapping code

This is a feature, not a compatibility failure.

## KasGraph-specific conclusion

KasGraph should not copy The Graph mechanically.

It should copy the parts that made The Graph successful:

- declarative manifests
- schema-first modeling
- deterministic WASM mappings
- CLI-centered developer workflow
- MCP / query interfaces that make data easy to consume

And it should replace the parts that are EVM assumptions with Kaspa-native primitives:

- covenant ids instead of contract addresses as the star of stateful indexing
- UTXOs instead of balance-slot assumptions
- pattern detection instead of ABI-only event decoding
- selected-chain / DAA-aware recovery instead of longest-chain intuition

That gives KasGraph the right slogan for compatibility:

**The Graph developer experience, re-grounded in Kaspa's actual data model.**

## Cross-reference

- `PLAN.md`
- `README.md`
- `sdk/src/index.ts`
- `mcp/src/index.ts`
- `cli/src/cli.ts`
- `crates/kasgraph-mapping/src/lib.rs`
- `docs/references/KASPA_RPC_REFERENCE.md`
- `docs/references/KIP20_COVENANT_ID_QUERIES.md`
