# KasGraph Testnet Soak Scripts

These scripts make a sustained testnet soak repeatable. They do not make production claims; they only capture artifacts.

## Required Environment

```bash
export DATABASE_URL=postgres://...
export KASGRAPH_ENVIRONMENT=testnet
export KASGRAPH_NETWORK=kaspa-testnet-10
export KASGRAPH_NOTIFICATION_WS_URL=wss://...
export KASGRAPH_RPC_PRIMARY_URL=wss://...
export KASGRAPH_DEPLOY_TOKEN=...
```

Do not commit `.env` files or raw logs. Public artifacts must be sanitized and reviewed first.

## Run

```bash
bash scripts/soak/run-testnet-soak.sh
```

Useful overrides:

```bash
SOAK_DURATION_SECONDS=86400
SOAK_INTERVAL_SECONDS=60
SOAK_DATE=2026-06-01
SOAK_ARTIFACT_DIR=artifacts/testnet-soak/2026-06-01
KASGRAPH_API_URL=http://127.0.0.1:4000
KASGRAPH_GRAPHQL_URL=http://127.0.0.1:4000/graphql
KASGRAPH_INDEXER_CMD='cargo run -p kasgraph-node'
KASGRAPH_API_CMD='node api/dist/main.js'
```

The script writes private artifacts under `artifacts/testnet-soak/YYYY-MM-DD/`. Copy only reviewed public artifacts into `docs/artifacts/testnet-soak/YYYY-MM-DD/`. Use `docs/restart-recovery-notes-template.md` for the restart artifact.

## Individual Capture Commands

```bash
bash scripts/soak/capture-health.sh artifacts/testnet-soak/2026-06-01
bash scripts/soak/capture-db-stats.sh artifacts/testnet-soak/2026-06-01
bash scripts/soak/capture-poi.sh artifacts/testnet-soak/2026-06-01
bash scripts/soak/capture-graphql-status.sh artifacts/testnet-soak/2026-06-01
```

## Sanitize Logs

```bash
npx tsx scripts/soak/sanitize-logs.ts \
  artifacts/testnet-soak/2026-06-01/raw-indexer.log \
  artifacts/testnet-soak/2026-06-01/public-indexer.jsonl
```

If `tsx` is unavailable, build a local JS wrapper or run through the test harness after compiling TypeScript. The sanitizer exports pure functions covered by `tests/soak-sanitize.test.ts`.

## Publish Reviewed Artifacts

After the run:

1. Sanitize raw logs.
2. Manually review sanitized files.
3. Copy reviewed public files into `docs/artifacts/testnet-soak/YYYY-MM-DD/`.
4. Add a measured `summary.json`.
5. Update `docs/testnet-soak-report.md` and `STATUS.md`.
6. Rebuild the site. The `/testnet-soak` and `/status` pages read the latest dated `summary.json` at build time.
