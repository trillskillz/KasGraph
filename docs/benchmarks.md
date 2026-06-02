# KasGraph Benchmarks

No production benchmark result is currently published.

Benchmark scripts live under `scripts/bench/` and write private artifacts to `artifacts/benchmarks/YYYY-MM-DD/`. Reviewed public artifacts belong under `docs/artifacts/benchmarks/YYYY-MM-DD/`.

## Methodology

Every benchmark result must include:

- Exact command/script used.
- Commit hash.
- Hardware specs.
- Database config summary, without secrets.
- Network.
- DAA range if applicable.
- Blocks indexed.
- Transactions indexed if available.
- Entities written if available.
- Date/time.

## Current Table

| Metric | Result | Environment | Dataset | Hardware | Date | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Indexing throughput | Pending | N/A | N/A | N/A | N/A | Requires a benchmark run; the completed soak artifact is not a throughput benchmark. |
| GraphQL p50/p95/p99 latency | Pending | N/A | N/A | N/A | N/A | Requires hosted endpoint and reviewed artifact. |
| Postgres storage growth | Pending | N/A | N/A | N/A | N/A | Requires a benchmark artifact with database size before/after the run. |
| POI checkpoint generation cost | Pending | N/A | N/A | N/A | N/A | Requires checkpoint timing instrumentation. |
| Memory usage | Pending | N/A | N/A | N/A | N/A | Requires benchmark-reviewed resource metrics. |
| CPU usage | Pending | N/A | N/A | N/A | N/A | Requires benchmark-reviewed resource metrics. |
| Disk I/O | Pending | N/A | N/A | N/A | N/A | Requires host metrics. |
| Restart recovery time | Pending | N/A | N/A | N/A | N/A | Requires controlled restart test. |
| API uptime | Pending | N/A | N/A | N/A | N/A | Requires uptime monitor or soak health snapshots. |
| WebSocket/KasStream latency | Pending | N/A | N/A | N/A | N/A | Requires hosted streaming path. |
| MCP tool latency | Pending | N/A | N/A | N/A | N/A | Requires hosted MCP path. |
| Reorg recovery latency | Pending | N/A | N/A | N/A | N/A | Requires controlled reorg simulation or observed reorg. |

Do not replace `Pending` with target values. Only measured values from reviewed artifacts belong here.
