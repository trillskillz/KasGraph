# KasGraph Benchmark Scripts

These scripts capture repeatable benchmark artifacts. They do not publish target values as results.

## Required Environment

```bash
export KASGRAPH_API_URL=http://127.0.0.1:4000
export KASGRAPH_GRAPHQL_URL=http://127.0.0.1:4000/graphql
export DATABASE_URL=postgres://...
```

## Run

```bash
bash scripts/bench/run-benchmarks.sh
```

Artifacts are written to `artifacts/benchmarks/YYYY-MM-DD/`. Copy only reviewed, non-secret outputs into `docs/artifacts/benchmarks/YYYY-MM-DD/`.

## Benchmarks

- GraphQL p50/p95/p99 latency.
- API uptime probe sample.
- Postgres storage/count snapshot.
- POI checkpoint count and latest checkpoint.
- Resource snapshot when host tools are available.

Indexing throughput, reorg latency, WebSocket/KasStream latency, MCP latency, and restart recovery time require a sustained run artifact and remain pending until measured.
