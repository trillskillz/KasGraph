# KasGraph Testnet Soak Report

## Summary

Status: completed
Verdict: Success: 24-hour testnet soak target reached.
Network: kaspa-testnet-10
Run date: 2026-06-01
Duration: 24.0 hours
Commit: 3ddc8a2
Environment: testnet
Hosted endpoint: N/A
Database: true
Machine specs: Not measured

This report is generated from real captured artifacts after the 24-hour testnet soak target was reached.

## Indexed Range

DAA start: 1
DAA end: 479501516
Indexed DAA delta: 479501515
Observed RPC DAA: 479501519
Observed RPC DAA delta: 479501518
Kaspad DAA: 479549436
Kaspad DAA delta: 479549435
Blocks indexed: 236759
Transactions indexed: Not measured
Entities written: Not measured
Subgraphs deployed: N/A
POI checkpoints generated: 236759

## Operational Results

RPC connected: true
Postgres connected: true
API health: true
GraphQL availability: true
MCP availability: Not measured
WebSocket/KasStream availability: Not measured
Kaspad synced: false
Kaspad phase: syncing live DAG
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

- log-tail: /docs/artifacts/testnet-soak/2026-06-01/public-log-tail.jsonl
- poi-checkpoints: /docs/artifacts/testnet-soak/2026-06-01/public-poi-checkpoints.jsonl
- db-stats: /docs/artifacts/testnet-soak/2026-06-01/public-db-stats.jsonl
- resource-metrics: /docs/artifacts/testnet-soak/2026-06-01/public-resource-metrics.jsonl
- restart-recovery-notes: /docs/artifacts/testnet-soak/2026-06-01/restart-recovery-notes.md

## Restart / Recovery Notes

Not measured

## Known Issues

- KasGraph soak API ran on 127.0.0.1:4002 because 127.0.0.1:4000 was occupied by LiteLLM.
- Root cause fixed before completion: local TN10 was stale kaspad v1.1.0 and root disk was too full for the Toccata pruning-point UTXO import; the completed run used kaspad v1.2.1-toc.3 with sufficient disk.
- At the 24-hour completion point, kaspad still reported phase syncing live DAG and kaspadSynced false; KasGraph indexing, RPC audit, Postgres, GraphQL health, and POI checkpoints remained active through the completion target.

## Fixes Required

- Keep publishing only sanitized artifacts.
- Run and document a controlled restart/recovery test if it remains unmeasured.
- Keep mainnet readiness blocked until the separate checklist in docs/mainnet-readiness.md passes.

## Final Verdict

Success: 24-hour testnet soak target reached.

No mainnet readiness is claimed.
