# KasGraph Operator Runbook

This runbook is a template for hosted KasGraph operations. Replace TODO placeholders with real provider, database, and contact details before any mainnet readiness claim.

## Deploy Procedure

1. Confirm the target commit and branch.
2. Confirm required environment variables:
   - `DATABASE_URL` or `KASGRAPH_DATABASE_URL`
   - `KASGRAPH_DEPLOY_TOKEN`
   - `KASGRAPH_ENVIRONMENT`
   - `KASGRAPH_NETWORK`
   - `GRAPHQL_ENDPOINT`
   - `KASGRAPH_SUBSCRIPTIONS_ENABLED`
3. Run TypeScript and Rust checks.
4. Apply database migrations.
5. Deploy API/indexer service.
6. Verify `/healthz`, `/health`, `/status`, and `/metrics`.
7. Verify GraphQL query path.
8. Verify deploy routes reject missing bearer tokens.
9. Update the site endpoint env vars only after the API is reachable.

## Rollback Procedure

1. Identify the last known good release.
2. Stop new deploy/remove writes by rotating or disabling `KASGRAPH_DEPLOY_TOKEN`.
3. Roll the service back through the hosting provider.
4. Check `/status` for database and checkpoint continuity.
5. Re-enable deploy writes only after read paths are healthy.

## Restart Indexer

1. Record current DAA score and latest POI checkpoint.
2. Restart the indexer process.
3. Confirm DAA score advances.
4. Confirm no checkpoint discontinuity.
5. Record restart duration and any replay/backfill behavior.

## Inspect Current DAA Score

Use `/status` first:

```bash
curl -fsS "$KASGRAPH_STATUS_URL/status"
```

If direct database inspection is required:

```sql
SELECT MAX(daa_score) AS indexed_daa_score
FROM kasgraph_committed_block;
```

## Inspect Latest POI Checkpoint

```sql
SELECT subgraph, block_daa_score, encode(poi_hash, 'hex') AS poi_hash_hex
FROM kasgraph_poi
ORDER BY block_daa_score DESC
LIMIT 1;
```

## Check Database Health

```bash
curl -fsS "$KASGRAPH_STATUS_URL/healthz"
```

```sql
SELECT 1;
```

## Recover From RPC Failure

1. Check RPC provider status.
2. Confirm reconnect logs.
3. Verify DAA score resumes advancing.
4. If the indexer stalls, restart it and record the recovery point.
5. Open a GitHub issue if checkpoint continuity is broken.

## Recover From Database Failure

1. Confirm Postgres connectivity from the service.
2. Check provider incident status.
3. Fail over or restore backup if configured.
4. Restart API/indexer after database is writable.
5. Verify `/healthz` and `/status`.
6. Verify latest POI checkpoint continuity.

## Restore Backup

1. Pause indexer writes.
2. Restore the selected backup into a staging database.
3. Run migration compatibility checks.
4. Promote restored database only after API smoke tests pass.
5. Resume indexer from the last valid checkpoint.

## Rotate Secrets

1. Generate a new deploy/admin token.
2. Update hosting provider secrets.
3. Redeploy or restart the API.
4. Verify old token is rejected and new token is accepted.

## Respond To High Query Load

1. Check GraphQL request count, error count, and p95 latency.
2. Enable stricter query limits if needed.
3. Confirm Postgres CPU, memory, and slow queries.
4. Temporarily pause public playground access if necessary.

## Diagnose Slow Queries

1. Identify the query and subgraph.
2. Capture query plan from Postgres.
3. Check entity table and index sizes.
4. Add or adjust indexes through a reviewed migration.
5. Publish benchmark notes after the fix.

## Handle Reorg Alerts

1. Capture DAA range, affected blocks, and checkpoint hashes.
2. Confirm unwind and replay completed.
3. Verify entity state after replay.
4. Compare POI continuity over the affected range.
5. File an incident note if manual intervention was required.

## Pause Public Access

1. Disable or restrict public GraphQL/playground routes at the hosting layer.
2. Keep `/healthz`, `/status`, and protected operator access available.
3. Post a status note on the site after the issue is understood.

## Emergency Contacts

- Primary operator: TODO
- Database provider support: TODO
- Hosting provider support: TODO
- KasGraph GitHub issue tracker: https://github.com/trillskillz/KasGraph/issues
