# Testnet Soak Artifacts

This directory is reserved for sanitized public artifacts from sustained KasGraph testnet soak runs.

No sustained 24-hour testnet soak artifact has been published yet. Do not add generated files here until:

1. The run completed or failed with real captured evidence.
2. `scripts/soak/sanitize-logs.ts` has been run.
3. A human has reviewed the sanitized files for secrets, private endpoints, IPs, local paths, and credentials.
4. `docs/testnet-soak-report.md` has been updated with only measured values.

Expected per-run structure:

```text
docs/artifacts/testnet-soak/YYYY-MM-DD/
  public-indexer-excerpt.jsonl
  public-api-health.jsonl
  public-poi-checkpoints.jsonl
  public-db-stats.jsonl
  restart-recovery-notes.md
  summary.json
```

Suggested `summary.json` shape:

```json
{
  "status": "completed",
  "verdict": "Passed initial testnet soak",
  "network": "kaspa-testnet-10",
  "runDate": "2026-06-01",
  "durationSeconds": 86400,
  "commit": "git-sha",
  "hostedEndpoint": "https://api.example.com",
  "daaStart": "0",
  "daaEnd": "0",
  "blocksIndexed": 0,
  "transactionsIndexed": "Not measured",
  "entitiesWritten": "Not measured",
  "poiCheckpoints": 0,
  "restartRecoveryVerdict": "Not measured",
  "knownIssues": [],
  "publicLogs": {
    "indexer": "/docs/artifacts/testnet-soak/2026-06-01/public-indexer-excerpt.jsonl",
    "apiHealth": "/docs/artifacts/testnet-soak/2026-06-01/public-api-health.jsonl",
    "poiCheckpoints": "/docs/artifacts/testnet-soak/2026-06-01/public-poi-checkpoints.jsonl",
    "dbStats": "/docs/artifacts/testnet-soak/2026-06-01/public-db-stats.jsonl",
    "restartNotes": "/docs/artifacts/testnet-soak/2026-06-01/restart-recovery-notes.md"
  }
}
```

Replace placeholder zeros with real measured values. Do not publish this file until the artifacts are sanitized and reviewed.
