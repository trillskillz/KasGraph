# KasBonds reference subgraph

KasBonds is a reference subgraph that demonstrates a covenant-id-driven
dataSource walking a single covenant lineage across its lifecycle:
issue → coupon payouts → redemption.

The mapping is real AssemblyScript example code compiled by `kasgraph build`,
but it is not audited financial logic. Treat it as a reference integration for
KasGraph's covenant indexing model, not as production KasBonds business logic.

## Layout

- `subgraph.yaml` — manifest. Pattern-based `covenant_id` source
  resolves to every UTXO matching `OpenSilverVault` or
  `OpenSilverEscrowMilestone`.
- `schema.graphql` — Bond / Holding / Coupon entities.
- `src/mapping.ts` — real example handlers (`handleBondIssued`,
  `handleBondTransition`). They key `Bond` entities by the stable
  `covenantId` supplied in KasGraph lock/spend payloads, so later spends in
  different blocks can load the same Bond.

## Build + deploy

```bash
kasgraph codegen          # writes src/generated/{entities,events}.ts
kasgraph build            # compiles AssemblyScript mappings → WASM
kasgraph deploy --database-url "$DATABASE_URL"
kasgraph deploy --node http://localhost:4000
```

`kasgraph deploy` can write directly to Postgres with `--database-url`, or send
the compiled bundle to a hosted node with `--node`. Public hosted nodes must set
`KASGRAPH_DEPLOY_TOKEN`; clients then send `Authorization: Bearer <token>` for
deploy/remove writes.
