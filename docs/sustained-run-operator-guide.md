# Sustained Run Operator Guide

This guide is for running a live KasGraph testnet soak on a persistent host. Do not use Vercel serverless for the indexer.

## Required Infrastructure

- Persistent Linux host, VPS, Fly.io machine, Railway service, Render background worker, Hetzner server, or equivalent.
- Managed or durable Postgres.
- Kaspa testnet RPC/wRPC endpoint.
- Disk space for artifacts.
- Process supervisor such as systemd, Docker Compose, tmux, or provider-managed services.

## Environment

```bash
export DATABASE_URL=postgres://...
export KASGRAPH_ENVIRONMENT=testnet
export KASGRAPH_NETWORK=kaspa-testnet-10
export KASGRAPH_NOTIFICATION_WS_URL=wss://...
export KASGRAPH_RPC_PRIMARY_URL=wss://...
export KASGRAPH_DEPLOY_TOKEN=...
export KASGRAPH_API_URL=http://127.0.0.1:4000
export KASGRAPH_GRAPHQL_URL=http://127.0.0.1:4000/graphql
export KASGRAPH_SOAK_ARTIFACT_DIR=docs/artifacts/sustained-run/live
```

## Start API

```bash
npm run typecheck
node api/dist/main.js
```

The API exposes `/healthz`, `/health`, `/status`, `/metrics`, and `/soak/*`.

## Start Live Soak

```bash
bash scripts/soak/start-live-soak.sh
```

The script initializes `summary.json`, starts the existing soak capture loop, writes public-safe artifacts, and periodically captures live API status.
After a non-failed run reaches 24 hours, the live summary reports `status: completed`,
`completionStatus: success`, and `targetReached: true`.

## Watch Live Progress

Open:

```text
https://www.kasgraph.com/testnet-soak/live
```

Set this Vercel/site env var before building the site:

```bash
NEXT_PUBLIC_KASGRAPH_SOAK_API_URL=https://your-api-host
```

## Restart / Recovery Test

```bash
KASGRAPH_INDEXER_PID=<pid> \
KASGRAPH_INDEXER_CMD='cargo run -p kasgraph-node' \
bash scripts/soak/restart-indexer-test.sh
```

The script appends public restart events to `restart-recovery-events.jsonl`. Fill `docs/restart-recovery-notes-template.md` with measured values for the final report.

## End The Run

```bash
bash scripts/soak/stop-live-soak.sh
```

Review all public artifacts, then archive:

```bash
mkdir -p docs/artifacts/sustained-run/YYYY-MM-DD
cp docs/artifacts/sustained-run/live/* docs/artifacts/sustained-run/YYYY-MM-DD/
```

The live capture script automatically runs `scripts/soak/publish-live-soak-completion.sh`
after the 24-hour target is reached. The publisher creates a dated
`docs/artifacts/testnet-soak/YYYY-MM-DD/summary.json`, updates the GitHub-facing
reports, and refreshes the static website artifact copy.

## Update Final Report

Update:

- `docs/sustained-run-report.md`
- `docs/testnet-soak-report.md`
- `STATUS.md`

Use measured values only. Leave unmeasured metrics as `Not measured` or `Unavailable`.
