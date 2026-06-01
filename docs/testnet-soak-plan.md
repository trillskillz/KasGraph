# KasGraph Testnet Soak Plan

No completed public testnet soak is claimed yet. This plan defines the first sustained validation run and the artifacts required before the site can show real operational proof.

## Environment

- Network: Kaspa testnet, preferably `kaspa-testnet-10` unless the operator records a different testnet.
- Minimum run duration: 24 hours.
- Preferred run duration: 72 hours or longer.
- Commit: record exact git commit before starting.
- Database: managed Postgres or documented local Postgres. Do not publish connection strings.
- Endpoint: hosted API URL if public; otherwise record `local only`.
- Artifact directory: `artifacts/testnet-soak/YYYY-MM-DD/` for private raw logs, with sanitized excerpts copied to `docs/artifacts/testnet-soak/YYYY-MM-DD/` only after review.

## Components Under Test

- KasGraph indexer node.
- Kaspa RPC / wRPC connection.
- Postgres persistence.
- GraphQL API.
- Proof-of-Indexing checkpoint generation.
- Reorg/recovery handling where observable.
- Restart recovery from persisted state.
- Public log capture and sanitization.

## Success Criteria

- Indexer runs continuously for the selected duration.
- Indexed DAA score advances.
- Postgres stays connected.
- API health remains available.
- POI checkpoints continue across the run.
- Controlled restart resumes from persisted state.
- Latest POI does not reset incorrectly after restart.
- No secret data appears in public logs.
- All known errors and warnings are documented.

## Failure Criteria

- DAA score stalls for an unresolved reason.
- Postgres disconnect cannot recover.
- RPC reconnect fails.
- Restart loses checkpoint continuity.
- POI chain diverges.
- API is unavailable for an unacceptable duration.
- Memory leak or disk growth becomes unsafe.
- Public logs contain secrets after sanitization review.

## Artifacts To Capture

- Raw internal logs:
  - `raw-indexer.log`
  - `raw-api.log`
- Sanitized public logs:
  - `public-indexer.jsonl`
  - `public-api-health.jsonl`
  - `public-poi-checkpoints.jsonl`
  - `public-db-stats.jsonl`
- API health/status snapshots.
- GraphQL query snapshots.
- POI checkpoint snapshots.
- Postgres entity/count snapshots.
- Restart/recovery notes.
- Resource metrics.
- Final `summary.json`.
- Final `docs/testnet-soak-report.md`.
- Restart note using `docs/restart-recovery-notes-template.md`.

## Snapshot Cadence

- Health/status: every 60 seconds by default.
- DB stats: every 5 minutes by default.
- POI checkpoint: every 5 minutes by default.
- GraphQL status query: every 5 minutes by default.
- Resource metrics: every 60 seconds if the host exposes `ps`, `df`, and process ids.

## Restart Test

1. Record current indexed DAA score.
2. Record latest POI checkpoint.
3. Stop the indexer cleanly.
4. Leave Postgres intact.
5. Restart the indexer.
6. Confirm RPC/wRPC reconnect.
7. Confirm persisted state reload.
8. Confirm DAA score continues advancing.
9. Confirm POI continuity.
10. Record recovery duration, warnings, and errors.

## Publication Rule

Only sanitized, reviewed artifacts belong in `docs/artifacts/testnet-soak/YYYY-MM-DD/`. Raw logs stay local or in protected operator storage.

When `docs/artifacts/testnet-soak/YYYY-MM-DD/summary.json` exists, the website can render the latest dated summary at build time. The summary must contain measured values only.
