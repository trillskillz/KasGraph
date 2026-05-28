# OpenSilver patterns reference subgraph

Phase 6.2 from `PLAN.md`. Indexes every UTXO matching a known
OpenSilver covenant pattern. Demonstrates the multi-pattern
`covenant_id` source where the detector registry resolves each
`pattern:` selector at ingest time.

## Use cases

- "Find every OpenSilver vault on Kaspa."
- "Show me every multisig with more than 3 signers."
- "Stream every milestone-escrow transition as it happens."

## Layout

- `subgraph.yaml` — manifest. Every detector kind in
  `crates/kasgraph-detectors/src/registry.rs` appears as a
  `pattern:` selector.
- `schema.graphql` — generic `PatternInstance` + specialised
  views per kind (Vault, Multisig, Escrow).
- `src/mapping.ts` — handlers branching on `event.payload.detectorKind`.
