<!-- Thanks for contributing to KasGraph. Keep PRs to one coherent, tested slice. -->

## What this changes

<!-- A short description of the change and why. -->

## Related

<!-- Issue / PLAN.md phase, if any. -->

## Checklist

- [ ] `npm run verify` is green (typecheck + vitest + `cargo test --workspace`)
- [ ] `cargo fmt --check` and `cargo clippy` are clean for touched crates
- [ ] New behavior has tests (and, if it touches SQL/the store, real-Postgres coverage where practical)
- [ ] Docs updated if the change is user-facing (README / `STATUS.md` / reference docs)
