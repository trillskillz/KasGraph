# Sustained Run Artifacts

Reviewed public sustained-run artifacts should be committed under dated folders:

```text
docs/artifacts/sustained-run/YYYY-MM-DD/
  public-indexer-excerpt.jsonl
  public-api-health.jsonl
  public-graphql-result.json
  public-poi-checkpoints.jsonl
  public-db-stats.jsonl
  public-resource-metrics.jsonl
  restart-recovery-notes.md
  summary.json
```

During an active run, the live dashboard reads from:

```text
docs/artifacts/sustained-run/live/
  summary.json
  public-api-health.jsonl
  public-indexer-events.jsonl
  public-poi-checkpoints.jsonl
  public-db-stats.jsonl
  public-resource-metrics.jsonl
  public-log-tail.jsonl
  restart-recovery-events.jsonl
```

Every artifact must include or be traceable to:

- Date/time.
- Network.
- Commit hash.
- Duration.
- DAA start/end.
- Blocks indexed.
- Transactions indexed if available.
- Entities written if available.
- Endpoint used.
- Machine/container specs.

Raw logs and secrets must not be committed.
