# KIP-20 Covenant ID queries

The reason KasGraph is dramatically easier to build than an EVM indexer is **KIP-20 Covenant IDs**. A covenant id is a 32-byte, consensus-tracked identifier that uniquely names a stateful contract instance and is stable across every transition in that instance's lineage. Walking lineage is a primary-key lookup, not a graph traversal.

## What KIP-20 gives us

| Property | EVM equivalent | KasGraph implication |
| --- | --- | --- |
| Stable per-instance identity | Contract address (similar) | First-class entity for every stateful subgraph |
| Lineage tracking by consensus | None — must walk event logs | Index lineage as a primary-key + sequence column |
| Cross-input cov-context (`OpInputCovenantId`, `OpCovInputIdx`, etc.) | Logs + heuristics | Direct read from chain — no parsing |
| Foreign-output binding (`validateOutputStateWithTemplate`) | Storage proofs + complex relayers | Indexer sees the binding inline |
| Recursive lineage proofs | Common (and an anti-pattern) | Forbidden by KIP-20 design — simpler indexing |

## What we expose at every layer

### GraphQL

Every UTXO entity exposes its covenant id as a first-class field, plus a `lineage` connection:

```graphql
type Utxo {
  id: ID!                          # tx_hash + ":" + output_index
  covenantId: String               # null for non-covenant outputs
  daaScore: BigInt!
  blockHash: String!
  value: BigInt!
  scriptPublicKey: String!
  lineage: [Utxo!]!                # prior UTXOs in this covenant lineage
  successor: Utxo                  # next UTXO in the lineage (null if active)
  spendingTx: String               # null if unspent
}
```

A subgraph asking "give me every state this Vault has been in" is one query:

```graphql
{
  utxo(id: "abc123:0") {
    covenantId
    lineage { daaScore scriptPublicKey value }
  }
}
```

### MCP

`get_covenant_lineage(covenant_id)` is one of the eight first-class MCP tools (see `PLAN.md` Phase 3.2). An LLM asking "show me everything that's happened to this Vault" gets the same lineage as a GraphQL caller.

### KasStream

Subscribers can pin a covenant id and receive every transition in real time:

```typescript
const stream = kasStream.subscribe({
  filter: { kind: 'CovenantId', value: '0xabc...' },
});
for await (const event of stream) {
  console.log(event.payload);
}
```

### WebSocket

GraphQL subscriptions accept a `covenantId` filter:

```graphql
subscription {
  utxoUpdates(where: { covenantId: "0xabc..." }) {
    daaScore
    scriptPublicKey
  }
}
```

## Postgres schema (Phase 2.4 target)

Lives in `crates/kasgraph-store/migrations/` once migrations land. Shape:

```sql
-- One row per covenant instance.
CREATE TABLE kasgraph_covenant (
    covenant_id    BYTEA PRIMARY KEY,         -- 32 bytes
    genesis_tx     BYTEA NOT NULL,            -- tx that minted this covenant
    genesis_output INTEGER NOT NULL,
    current_utxo   BYTEA NOT NULL,            -- latest UTXO carrying this cov_id
    lineage_count  INTEGER NOT NULL DEFAULT 1,
    last_seen_daa  BIGINT NOT NULL
);
CREATE INDEX kasgraph_covenant_last_seen ON kasgraph_covenant (last_seen_daa);

-- Append-only lineage rows. seq starts at 0 for genesis.
CREATE TABLE kasgraph_covenant_lineage (
    covenant_id BYTEA NOT NULL REFERENCES kasgraph_covenant(covenant_id),
    seq         INTEGER NOT NULL,
    tx_hash     BYTEA NOT NULL,
    output_idx  INTEGER NOT NULL,
    daa_score   BIGINT NOT NULL,
    state_bytes BYTEA,                        -- spliced state window if known
    PRIMARY KEY (covenant_id, seq)
);
CREATE INDEX kasgraph_covenant_lineage_daa ON kasgraph_covenant_lineage (daa_score);
```

This schema is the minimal shape that makes lineage queries O(seq) and "latest state of covenant X" O(1).

## Lineage walking — the simple algorithm

Every spend of a covenant UTXO produces an output that carries the same covenant id. The indexer:

1. On each new block, for every transaction input that consumes a covenant UTXO, look up the input's `covenant_id`.
2. For every output of that transaction whose `covenant_id` matches, append a row to `kasgraph_covenant_lineage` with `seq = (prior seq) + 1`.
3. Update `kasgraph_covenant.current_utxo` and `lineage_count` and `last_seen_daa`.

No recursive walking. No event-log inference. The chain tells us the lineage by construction.

### Edge cases

- **Multi-input cov-context (N:M shape).** When N inputs share a covenant id (KIP-20 leader/delegate pattern, e.g. OpenSilver's 5.4 Proof-Stitched Multi-Pattern), the lineage row records the leader's transition; delegate inputs are tracked as a separate `kasgraph_covenant_delegate` table referencing the same `(covenant_id, seq)` pair.
- **Foreign-output binding via `validateOutputStateWithTemplate`.** The OpenSilver KCC20 controllers + the 5.3 v2 oracle pin a foreign covenant's output state. The indexer records this as a `kasgraph_covenant_binding` row linking the producing covenant id to the consumed/produced covenant id, so a downstream MCP query like "what oracle produced this consumer UTXO" is direct.
- **Reorgs.** BlockDAG reorgs that move a lineage row's confirming block require rolling back the `kasgraph_covenant_lineage` rows past the reorg point and re-replaying. POI checkpoints make this safe.

## Detector integration

The `kasgraph-detectors` crate runs *after* lineage tracking. When a detector matches a UTXO against a known pattern (`OpenSilverVault`, `KCC20Asset`, etc.), it tags the covenant id with the pattern. This means:

- "Find every OpenSilver Vault on Kaspa" is a single covenant join with a pattern-tag filter.
- "Find every covenant whose template hash matches a pinned OpenSilver compile recipe" is a primary-key lookup.

The detector's pattern-id is also the input to the manifest's `source.kind = covenant_id, ids: [{ pattern: "opensilver.vault" }]` form — i.e. a subgraph can index by pattern without naming individual covenant instances.

## What this doc does not cover (yet)

- The exact RPC fields exposing covenant ids — that's `KASPA_RPC_REFERENCE.md` (Phase 1.2).
- The byte-level template format that detectors fingerprint — that's the OpenSilver `state_layout` ABI, captured in the sibling OpenSilver repo's pattern docs.
- BlockDAG-specific reorg semantics for lineage rollback — that's `BLOCKDAG_REORG_SEMANTICS.md` (Phase 1.5).

## Source-of-truth references

- KIP-20: `references/kips/kip-0020.md` in this repo once mirrored; canonical at `github.com/kaspanet/kips` PR branch.
- KIP-20 architectural patterns + opcode list: see the same SUMMARY in the sibling OpenSilver repo at `references/kips/SUMMARY.md`.
- `OpInputCovenantId` / `OpCovInputCount` / `OpCovOutputIdx` / `OpCovOutputCount` opcodes: implemented in `kaspanet/rusty-kaspa` `crypto/txscript/src/opcodes/`.
