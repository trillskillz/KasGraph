# KasGraph Monitoring

KasGraph exposes lightweight operational endpoints from the API process:

- `GET /healthz`: existing load-balancer health check backed by `SELECT 1`.
- `GET /health`: alias for `/healthz`.
- `GET /status`: JSON status document assembled from observable API and Postgres state.
- `GET /metrics`: Prometheus-compatible text metrics for API process memory and visible Postgres counts.

## Status Fields

`/status` should be treated as public high-level status. It intentionally returns `rpcConnected: "unavailable"` until the hosted API is wired to an indexer/RPC liveness source.

Values that are not available must stay `null`, `0`, or `"unavailable"` rather than being inferred.

## Current Metrics

- `kasgraph_postgres_connected`
- `kasgraph_indexed_blocks_total`
- `kasgraph_indexed_daa_score`
- `kasgraph_poi_checkpoints_total`
- `kasgraph_subgraphs_deployed`
- `kasgraph_process_memory_rss_bytes`

## Required Alerts Before Production Claims

- API down.
- Postgres disconnected.
- RPC disconnected.
- Indexer stalled.
- DAA score not advancing.
- High memory.
- High CPU.
- Disk pressure.
- GraphQL error spike.
- POI checkpoint failure.
- WebSocket/KasStream failure.
- MCP tool failure.

## Log Access Policy

Detailed API and indexer logs must be protected. The public site may show healthy, degraded, or offline status, but it must not expose bearer tokens, database URLs, request authorization headers, deploy payloads, or tenant secrets.

The CLI `logs` command should remain preview/stubbed until a protected hosted log source exists.
