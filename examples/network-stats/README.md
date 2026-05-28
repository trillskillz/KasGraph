# Network Stats reference subgraph

Phase 6.5 from `PLAN.md`. Surfaces network-wide Kaspa metrics —
block production, transaction volume, address activity, and fees —
as queryable aggregates.

## Why a firehose subgraph

The other reference subgraphs scope to a covenant family. Network
stats are the opposite: they roll up the *whole* chain. The
`utxo` data-source kind with an `addresses: ["*"]` selector is the
chain-wide firehose — every output created or spent — from which
transaction volume, fees, and per-address activity all derive.
Block production (block count, blue/DAA score, block interval)
comes from the block stream the indexer already consumes, handled
in `handleBlockAdded`.

## Entities

- **BlockStat** — one row per accepted block: tx count, fee total,
  output volume, parent count. The raw series behind "blocks per
  second" and "fees per block".
- **DailyStat** — per-UTC-day rollup: block/tx counts, total fees
  and volume, active-address count, average block interval.
- **AddressActivity** — per-address lifetime counters: tx count,
  received/sent totals, live UTXO count, first/last seen DAA.

## Notes

`DailyStat` is intentionally coarse (one row per day) so dashboards
can query long ranges cheaply; `BlockStat` keeps the full
per-block resolution for anyone who needs it. Both are populated
from the same firehose pass, so they never drift.
