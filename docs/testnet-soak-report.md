# KasGraph Testnet Soak Report

## Summary

Status: Incomplete; sustained soak has not been run.
Verdict: Incomplete; more data required.
Network: Intended target is Kaspa testnet / `kaspa-testnet-10`.
Run date: N/A
Duration: N/A
Commit: N/A
Environment: N/A
Hosted endpoint: N/A
Database: N/A
Machine specs: N/A

This report is intentionally not a validation claim. It is the report structure that must be filled from real artifacts after a minimum 24-hour testnet run.

## Indexed Range

DAA start: N/A
DAA end: N/A
Blocks indexed: N/A
Transactions indexed: Not measured
Entities written: Not measured
Subgraphs deployed: N/A
POI checkpoints generated: N/A

## Operational Results

RPC connected: N/A
RPC reconnects: Not measured
Postgres connected: N/A
API health: N/A
GraphQL availability: N/A
MCP availability: Not measured
WebSocket/KasStream availability: Not measured
Reorgs detected: Not measured
Reorgs recovered: Not measured
Restart recovery: Not measured
Backfill/gap recovery: Not measured

## Resource Usage

Average CPU: Not measured
Peak CPU: Not measured
Average memory: Not measured
Peak memory: Not measured
Disk growth: Not measured
Database growth: Not measured

## Public Logs

Link to sanitized indexer logs: Not published
Link to API health snapshots: Not published
Link to POI checkpoint snapshots: Not published
Link to DB stats snapshots: Not published
Link to restart/recovery notes: Not published

Public artifacts will be published under `docs/artifacts/testnet-soak/YYYY-MM-DD/` after `scripts/soak/sanitize-logs.ts` runs and the output is manually reviewed.

## Restart / Recovery Notes

No controlled restart test has been run yet. The required procedure is documented in `docs/testnet-soak-plan.md` and the generated artifact must include:

```markdown
# Restart / Recovery Notes

Date:
Commit:
Network:
Pre-restart DAA:
Pre-restart POI:
Restart time:
Post-restart DAA:
Post-restart POI:
Recovery duration:
RPC reconnect result:
Postgres reconnect result:
Gap recovery result:
POI continuity result:
Issues observed:
Fixes required:
Verdict:
```

## Known Issues

- No sustained 24-hour testnet indexing run has been captured.
- No public hosted endpoint was validated during a soak.
- No public sanitized logs have been published.
- No restart/recovery artifact exists yet.
- GraphQL p95 latency, resource usage, DB growth, MCP latency, and WebSocket/KasStream latency are not measured.

## Fixes Required

- Run `scripts/soak/run-testnet-soak.sh` against a real testnet deployment for at least 24 hours.
- Perform and document a controlled restart/recovery test.
- Sanitize raw logs and publish reviewed public artifacts.
- Update this report and `STATUS.md` with measured values only.
- Keep mainnet readiness blocked until the separate checklist in `docs/mainnet-readiness.md` passes.

## Final Verdict

Incomplete; more data required.

No mainnet readiness is claimed.
