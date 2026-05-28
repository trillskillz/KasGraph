# KasBonds reference subgraph

Phase 6.1 from `PLAN.md`. First reference subgraph; demonstrates a
covenant-id-driven dataSource walking a single covenant lineage
across its lifecycle (issue → coupon payouts → redemption).

## Layout

- `subgraph.yaml` — manifest. Pattern-based `covenant_id` source
  resolves to every UTXO matching `OpenSilverVault` or
  `OpenSilverEscrowMilestone`.
- `schema.graphql` — Bond / Holding / Coupon entities.
- `src/mapping.ts` — handler stubs (`handleBondIssued`,
  `handleBondTransition`) with documented pseudo-code for the
  full impl. Real bodies depend on per-detector payload codegen
  (next slice).

## Build + deploy

```bash
kasgraph codegen          # writes src/generated/{entities,events}.ts
kasgraph build            # compile mappings → WASM (waits on Phase 2.6)
kasgraph deploy --node http://localhost:4000
```
