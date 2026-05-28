# Native KRC-20 (KCC20) reference subgraph

Phase 6.3 from `PLAN.md`. Indexes the native post-Toccata KRC-20
family: KCC20 asset contracts + the four controller variants
(Ownable / Pausable / Capped / Vesting).

## Why a separate subgraph from `kasbonds` / `opensilver-patterns`

Token holder accounting is its own indexing pattern: per-(asset,
address) balance state changes on every transfer / mint / burn,
not just on lineage transitions. Keeping the schema in one place
means token explorers, wallets, and AMMs can subscribe to a
single canonical KRC-20 view.

## Replaces Kasplex for the native era

Kasplex covers the legacy inscription-style KRC-20 (Phase 1
reference doc: `docs/references/KRC20_KRC721_REFERENCE.md`).
This subgraph covers the native (KCC20) post-Toccata era and
should be deployed alongside any Kasplex legacy view that still
exists for migration purposes.
