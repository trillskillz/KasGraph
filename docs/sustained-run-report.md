# KasGraph Sustained Run Report

Status: Completed successfully.

This report is generated from the reviewed live soak summary artifact.

## Summary

Status: completed
Verdict: Success: 24-hour testnet soak target reached.
Network: kaspa-testnet-10
Run date: 2026-06-01
Duration: 24.0 hours
Commit: 3ddc8a2
Endpoint: N/A
Machine/container specs: Not measured

## Indexed Range

DAA start: 1
DAA end: 479501516
Blocks indexed: 236759
Transactions indexed: Not measured
Entities written: Not measured
POI checkpoints generated: 236759

## Operational Results

RPC connected: true
Kaspad synced: false
Kaspad phase: syncing live DAG
Postgres health: true
API health: true
GraphQL availability: true
Restart recovery: Not measured
Reorg/recovery handling: Not measured

## Public Artifacts

- Summary JSON: /docs/artifacts/testnet-soak/2026-06-01/summary.json
- log-tail: /docs/artifacts/testnet-soak/2026-06-01/public-log-tail.jsonl
- poi-checkpoints: /docs/artifacts/testnet-soak/2026-06-01/public-poi-checkpoints.jsonl
- db-stats: /docs/artifacts/testnet-soak/2026-06-01/public-db-stats.jsonl
- resource-metrics: /docs/artifacts/testnet-soak/2026-06-01/public-resource-metrics.jsonl
- restart-recovery-notes: /docs/artifacts/testnet-soak/2026-06-01/restart-recovery-notes.md

## Known Issues

- KasGraph soak API ran on 127.0.0.1:4002 because 127.0.0.1:4000 was occupied by LiteLLM.
- Root cause fixed before completion: local TN10 was stale kaspad v1.1.0 and root disk was too full for the Toccata pruning-point UTXO import; the completed run used kaspad v1.2.1-toc.3 with sufficient disk.
- At the 24-hour completion point, kaspad still reported phase syncing live DAG and kaspadSynced false; KasGraph indexing, RPC audit, Postgres, GraphQL health, and POI checkpoints remained active through the completion target.

## Final Verdict

Success: 24-hour testnet soak target reached.
