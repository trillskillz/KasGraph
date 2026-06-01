# KasGraph Mainnet Readiness

KasGraph is not mainnet production-ready until every gate below has a dated validation artifact. This checklist is intentionally operational: do not convert pending items into public claims until the linked evidence exists.

## Infrastructure Readiness

- [ ] Hosted API stable on a public base URL.
- [ ] Managed Postgres provisioned with backups enabled.
- [ ] Monitoring configured for API, indexer, Postgres, and RPC connectivity.
- [ ] Log streaming configured with protected detailed access.
- [ ] Public read routes rate-limited.
- [ ] Admin/deploy routes protected by bearer-token auth.
- [ ] Deployment rollback tested.
- [ ] `/healthz`, `/health`, `/status`, and `/metrics` reachable from the hosting platform.

## Indexer Readiness

- [ ] Testnet soak passed with a published report.
- [ ] Backfill tested from an empty database.
- [ ] Restart recovery tested from the latest checkpoint.
- [ ] Reorg handling tested with controlled simulation or captured reorg traces.
- [ ] Proof-of-Indexing checkpoint continuity verified.
- [ ] Database migrations tested against a copy of production-like data.
- [ ] CLI inspection commands available for health, index status, POI, DB, RPC, and logs.

## API Readiness

- [ ] GraphQL schema reviewed and versioned.
- [ ] Public playground live against the intended environment.
- [ ] API docs published with endpoint paths and query examples.
- [ ] GraphQL error handling tested.
- [ ] Query depth, complexity, or timeout limits enforced.
- [ ] Abusive query protection configured.
- [ ] CORS configured for `https://www.kasgraph.com`, `https://kasgraph.com`, and local development only.

## Observability Readiness

- [ ] Health checks.
- [ ] Metrics.
- [ ] Alerts.
- [ ] Logs.
- [ ] Uptime tracking.
- [ ] Resource dashboards.
- [ ] Indexer-stall detection.
- [ ] DAA-score advancement tracking.
- [ ] POI-checkpoint failure alert.

## Security Readiness

- [ ] Secrets are not committed.
- [ ] Admin routes protected.
- [ ] CORS configured.
- [ ] Rate limits enabled.
- [ ] Dependency audit performed.
- [ ] Public endpoint reviewed.
- [ ] Database credentials rotated after initial setup.
- [ ] Least-privilege database users configured.

## Documentation Readiness

- [ ] Install docs.
- [ ] Run-local docs.
- [ ] Hosted endpoint docs.
- [ ] GraphQL examples.
- [ ] CLI docs.
- [ ] MCP docs.
- [ ] Troubleshooting docs.
- [ ] Mainnet runbook.

## Required Evidence Before Mainnet Claim

- Testnet soak report with duration, DAA range, indexed blocks, entity counts, POI checkpoints, restarts, resource usage, and known issues.
- Benchmark report with methodology, hardware, dataset, commit hash, and raw outputs.
- Monitoring screenshot or exported config showing alert coverage.
- Rollback test notes.
- Security review notes for public read and protected admin paths.
