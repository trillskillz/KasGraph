# Contributing to KasGraph

KasGraph is infrastructure, not a product. The bar for changes is correctness, determinism, and forward-compatibility with KIP-20 / KIP-16 / vProgs. The structure for getting there is laid out per-phase in `PLAN.md`.

## Quick orientation

- **Read `PLAN.md` first.** Every PR slots into a phase. If your change doesn't fit a phase, open an issue first so we can figure out where it belongs (or extend the plan).
- **Read one fully-landed component before extending it.** `kasgraph-poi` is the smallest, most complete example today — real logic, real tests, conventions other crates will follow.
- **Determinism is non-negotiable.** Indexers that produce different state from the same chain are bugs. POI hashes are the regression gate.

## Development setup

```bash
git clone https://github.com/trillskillz/KasGraph && cd KasGraph
npm install
npm run verify              # tsc -b + vitest + cargo test --workspace
```

CI runs the same commands on every push and PR.

## Adding work — checklist by phase

### Phase 1 (reference docs)

- Drop into `docs/references/<TOPIC>.md`.
- Cite the source-of-truth upstream (rusty-kaspa source, KIP text, The Graph docs, etc.) by URL + commit SHA where stable.
- Document at least one example query / message / data shape.
- Cross-link from `STATUS.md` "What's done" once landed.

### Phase 2 (core indexer crates)

For each crate change:

1. New surface lives in `src/<module>.rs` with a doc-comment header citing the relevant PLAN.md task (e.g. "Per `PLAN.md` Phase 2.4").
2. Public types get `#[derive(Debug)]` minimally. Add `Clone` only when needed; add `Serialize`/`Deserialize` only when crossing a wire boundary.
3. Errors are `thiserror`-derived enums per crate. No `anyhow` in library crates.
4. Cargo unit tests live inline (`#[cfg(test)] mod tests`). Integration tests live under each crate's `tests/` directory.
5. Update the crate's `Cargo.toml` description if the responsibilities change.

### Phase 3 (interface layer)

- GraphQL changes must update `@kasgraph/api` and the resolver generation rules in lockstep.
- MCP changes must update both `mcp/src/index.ts` (typed tool list) AND `tests/sdk.test.ts` "exposes the canonical MCP tool set" assertion. The test fails on drift on purpose.
- KasStream changes require backpressure + cancellation tests; latency-sensitive consumers depend on this.

### Phase 4 (CLI + SDK)

- Every new CLI command needs a vitest test in `tests/` covering stdout, exit code, and error paths.
- `@kasgraph/sdk` is the public API. Breaking changes require a version bump in `package.json` AND a CHANGELOG.md entry.

### Phase 6 (reference subgraphs)

- Live under `examples/<name>/`.
- Must include: `subgraph.yaml`, `schema.graphql`, `src/mapping.ts`, a `README.md` documenting what queries the subgraph supports.
- Reference subgraphs are the dogfooding surface — if your subgraph can't run on `kasgraph-node`, neither can a user's.

## Commit conventions

```
<type>(<scope>): <one-line summary>

<blank line>

<body explaining the why, not just the what>
```

Types:

- `feat` — new crate, new surface, new subgraph.
- `fix` — bugfix without API change.
- `docs` — docs only (PLAN.md, STATUS.md, reference docs, READMEs).
- `test` — test-only.
- `ci` — CI workflow / drift gates.
- `chore` — workspace plumbing.
- `refactor` — internal reshaping; no behavior change.

For commit bodies, the diff shows the *what*. The body should say *why this design* and what's hard about it.

## Pull request expectations

- CI green: TS typecheck + vitest + cargo build + cargo test.
- For new crates: a unit test that exercises the public surface, not just `assert!(true)`.
- For new RPC / Postgres / WASM surfaces: an integration test against a fixture, not just unit tests.
- Update `STATUS.md` if your change shifts a phase status.
- Update `NEXT_SESSION.md` if your change clears or rephrases queued work.

## License

By contributing, you agree your work is licensed under the MIT license that covers the rest of the repository.
