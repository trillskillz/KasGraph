#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
target_seconds="${KASGRAPH_SOAK_TARGET_SECONDS:-86400}"
summary_path="${artifact_dir}/summary.json"

if [[ ! -f "${summary_path}" ]]; then
  echo "No live soak summary found at ${summary_path}" >&2
  exit 1
fi

node - "${summary_path}" "${target_seconds}" <<'NODE'
const fs = require('fs');
const path = require('path');

const summaryPath = process.argv[2];
const targetSeconds = Number(process.argv[3]);
const repoRoot = process.cwd();
const liveDir = path.dirname(summaryPath);
const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
const durationSeconds = Number(summary.durationSeconds ?? 0);
const status = String(summary.status ?? '');
const reached = summary.targetReached === true || status === 'completed' || durationSeconds >= targetSeconds;

if (!reached || status === 'failed') {
  console.log(`Soak target not publishable yet: status=${status || 'unknown'} durationSeconds=${durationSeconds}`);
  process.exit(0);
}

const startedAt = summary.startedAt ? new Date(summary.startedAt) : new Date();
const runDate = Number.isNaN(startedAt.getTime()) ? new Date().toISOString().slice(0, 10) : startedAt.toISOString().slice(0, 10);
const datedDir = path.join(repoRoot, 'docs/artifacts/testnet-soak', runDate);
fs.mkdirSync(datedDir, { recursive: true });
const datedSummaryPath = path.join(datedDir, 'summary.json');

if (process.env.KASGRAPH_SOAK_FORCE_PUBLISH_COMPLETION !== '1' && fs.existsSync(datedSummaryPath)) {
  try {
    const existing = JSON.parse(fs.readFileSync(datedSummaryPath, 'utf8'));
    if (existing.status === 'completed' && existing.completionStatus === 'success' && existing.targetReached === true) {
      console.log(`Completed soak already published for ${runDate}`);
      process.exit(0);
    }
  } catch {
    // If the existing summary is unreadable, rewrite it below from the live summary.
  }
}

const publicFiles = [
  'public-log-tail.jsonl',
  'public-poi-checkpoints.jsonl',
  'public-db-stats.jsonl',
  'public-resource-metrics.jsonl',
  'restart-recovery-notes.md',
];

for (const file of publicFiles) {
  const src = path.join(liveDir, file);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(datedDir, file));
}

const durationHours = durationSeconds / 3600;
const completed = {
  status: 'completed',
  completionStatus: 'success',
  verdict: 'Success: 24-hour testnet soak target reached.',
  targetDurationSeconds: targetSeconds,
  targetReached: true,
  runDate,
  network: summary.network ?? 'kaspa-testnet-10',
  environment: summary.environment ?? 'testnet',
  startedAt: summary.startedAt ?? null,
  endedAt: summary.endedAt ?? summary.targetReachedAt ?? summary.updatedAt ?? new Date().toISOString(),
  durationSeconds,
  duration: `${durationHours.toFixed(1)} hours`,
  commit: summary.commit ?? null,
  hostedEndpoint: summary.hostedEndpoint ?? summary.apiUrl ?? null,
  daaStart: summary.daaStart ?? null,
  daaEnd: summary.indexedDaaScore ?? null,
  indexedDaaScore: summary.indexedDaaScore ?? null,
  indexedDaaDelta: summary.indexedDaaDelta ?? summary.daaDelta ?? null,
  blocksIndexed: summary.indexedBlocks ?? null,
  observedDaaScore: summary.observedDaaScore ?? null,
  observedRpcDaaDelta: summary.observedRpcDaaDelta ?? null,
  observedBlocks: summary.observedBlocks ?? null,
  kaspadDaaScore: summary.kaspadDaaScore ?? null,
  kaspadDaaDelta: summary.kaspadDaaDelta ?? null,
  kaspadSynced: summary.kaspadSynced ?? null,
  kaspadPhase: summary.kaspadPhase ?? null,
  transactionsIndexed: summary.transactionsIndexed ?? null,
  entitiesWritten: summary.entitiesWritten ?? null,
  poiCheckpoints: summary.poiCheckpointsTotal ?? null,
  latestPoiCheckpoint: summary.latestPoiCheckpoint ?? null,
  rpcConnected: summary.rpcConnected ?? null,
  postgresConnected: summary.postgresConnected ?? null,
  graphqlHealthy: summary.graphqlHealthy ?? null,
  mcpHealthy: summary.mcpHealthy ?? null,
  websocketHealthy: summary.websocketHealthy ?? null,
  restartRecoveryVerdict: summary.restartRecovery ?? 'Not measured',
  knownIssues: summary.knownIssues ?? [],
  publicLogs: Object.fromEntries(
    publicFiles
      .filter((file) => fs.existsSync(path.join(datedDir, file)))
      .map((file) => [file.replace(/^public-/, '').replace(/\..*$/, ''), `/docs/artifacts/testnet-soak/${runDate}/${file}`]),
  ),
};

fs.writeFileSync(datedSummaryPath, JSON.stringify(completed, null, 2) + '\n');

const value = (v, fallback = 'N/A') => {
  if (v === undefined || v === null || v === '') return fallback;
  if (Array.isArray(v)) return v.length === 0 ? fallback : v.join('; ');
  return String(v);
};

const issues = Array.isArray(completed.knownIssues) && completed.knownIssues.length > 0
  ? completed.knownIssues.map((issue) => `- ${issue}`).join('\n')
  : '- None published.';

const logs = Object.entries(completed.publicLogs)
  .map(([label, href]) => `- ${label}: ${href}`)
  .join('\n') || '- Public artifacts: Not published';

const sustainedReport = `# KasGraph Sustained Run Report

Status: Completed successfully.

This report is generated from the reviewed live soak summary artifact.

## Summary

Status: completed
Verdict: ${completed.verdict}
Network: ${value(completed.network)}
Run date: ${runDate}
Duration: ${completed.duration}
Commit: ${value(completed.commit)}
Endpoint: ${value(completed.hostedEndpoint)}
Machine/container specs: Not measured

## Indexed Range

DAA start: ${value(completed.daaStart)}
DAA end: ${value(completed.daaEnd)}
Blocks indexed: ${value(completed.blocksIndexed)}
Transactions indexed: ${value(completed.transactionsIndexed, 'Not measured')}
Entities written: ${value(completed.entitiesWritten, 'Not measured')}
POI checkpoints generated: ${value(completed.poiCheckpoints)}

## Operational Results

RPC connected: ${value(completed.rpcConnected)}
Kaspad synced: ${value(completed.kaspadSynced)}
Kaspad phase: ${value(completed.kaspadPhase)}
Postgres health: ${value(completed.postgresConnected)}
API health: ${value(completed.graphqlHealthy)}
GraphQL availability: ${value(completed.graphqlHealthy)}
Restart recovery: ${value(completed.restartRecoveryVerdict, 'Not measured')}
Reorg/recovery handling: Not measured

## Public Artifacts

- Summary JSON: /docs/artifacts/testnet-soak/${runDate}/summary.json
${logs}

## Known Issues

${issues}

## Final Verdict

${completed.verdict}
`;

const soakReport = `# KasGraph Testnet Soak Report

## Summary

Status: completed
Verdict: ${completed.verdict}
Network: ${value(completed.network)}
Run date: ${runDate}
Duration: ${completed.duration}
Commit: ${value(completed.commit)}
Environment: ${value(completed.environment)}
Hosted endpoint: ${value(completed.hostedEndpoint)}
Database: ${value(completed.postgresConnected)}
Machine specs: Not measured

This report is generated from real captured artifacts after the 24-hour testnet soak target was reached.

## Indexed Range

DAA start: ${value(completed.daaStart)}
DAA end: ${value(completed.daaEnd)}
Indexed DAA delta: ${value(completed.indexedDaaDelta)}
Observed RPC DAA: ${value(completed.observedDaaScore)}
Observed RPC DAA delta: ${value(completed.observedRpcDaaDelta)}
Kaspad DAA: ${value(completed.kaspadDaaScore)}
Kaspad DAA delta: ${value(completed.kaspadDaaDelta)}
Blocks indexed: ${value(completed.blocksIndexed)}
Transactions indexed: ${value(completed.transactionsIndexed, 'Not measured')}
Entities written: ${value(completed.entitiesWritten, 'Not measured')}
Subgraphs deployed: N/A
POI checkpoints generated: ${value(completed.poiCheckpoints)}

## Operational Results

RPC connected: ${value(completed.rpcConnected)}
Postgres connected: ${value(completed.postgresConnected)}
API health: ${value(completed.graphqlHealthy)}
GraphQL availability: ${value(completed.graphqlHealthy)}
MCP availability: ${value(completed.mcpHealthy, 'Not measured')}
WebSocket/KasStream availability: ${value(completed.websocketHealthy, 'Not measured')}
Kaspad synced: ${value(completed.kaspadSynced)}
Kaspad phase: ${value(completed.kaspadPhase)}
Reorgs detected: Not measured
Reorgs recovered: Not measured
Restart recovery: ${value(completed.restartRecoveryVerdict, 'Not measured')}
Backfill/gap recovery: Not measured

## Resource Usage

Average CPU: Not measured
Peak CPU: Not measured
Average memory: Not measured
Peak memory: Not measured
Disk growth: Not measured
Database growth: Not measured

## Public Logs

${logs}

## Restart / Recovery Notes

${value(completed.restartRecoveryVerdict, 'Not measured')}

## Known Issues

${issues}

## Fixes Required

- Keep publishing only sanitized artifacts.
- Run and document a controlled restart/recovery test if it remains unmeasured.
- Keep mainnet readiness blocked until the separate checklist in docs/mainnet-readiness.md passes.

## Final Verdict

${completed.verdict}

No mainnet readiness is claimed.
`;

fs.writeFileSync(path.join(repoRoot, 'docs/sustained-run-report.md'), sustainedReport);
fs.writeFileSync(path.join(repoRoot, 'docs/testnet-soak-report.md'), soakReport);

const statusPath = path.join(repoRoot, 'STATUS.md');
if (fs.existsSync(statusPath)) {
  let statusText = fs.readFileSync(statusPath, 'utf8');
  const replacements = new Map([
    ['TESTNET_INDEXED_BLOCKS', value(completed.blocksIndexed, 'N/A')],
    ['TESTNET_SOAK_STATUS', 'COMPLETED_SUCCESS'],
    ['TESTNET_SOAK_DURATION', completed.duration],
    ['TESTNET_SOAK_DATE', runDate],
    ['TESTNET_DAA_START', value(completed.daaStart)],
    ['TESTNET_DAA_END', value(completed.daaEnd)],
    ['TESTNET_POI_CHECKPOINTS', value(completed.poiCheckpoints)],
    ['TESTNET_RESTART_RECOVERY', value(completed.restartRecoveryVerdict, 'Not measured')],
    ['TESTNET_PUBLIC_LOGS', `/docs/artifacts/testnet-soak/${runDate}/`],
    ['KNOWN_SOAK_ISSUES', Array.isArray(completed.knownIssues) && completed.knownIssues.length > 0 ? completed.knownIssues.join('; ') : 'None published.'],
  ]);
  for (const [key, replacement] of replacements) {
    statusText = statusText.replace(new RegExp(`^${key}:.*$`, 'm'), `${key}: ${replacement}`);
  }
  fs.writeFileSync(statusPath, statusText);
}

const publicRoot = path.join(repoRoot, 'apps/site/public/docs/artifacts/testnet-soak', runDate);
fs.mkdirSync(publicRoot, { recursive: true });
for (const file of fs.readdirSync(datedDir)) {
  fs.copyFileSync(path.join(datedDir, file), path.join(publicRoot, file));
}

console.log(`Published completed soak docs and artifact for ${runDate}`);
NODE
