// kasgraph-api — operator entry binary.
//
// Reads env config, constructs a pg.Pool, wires it into
// `createKasGraphServer`, and exposes the resulting Yoga handler
// via Node's built-in `http` module. Adds a `/healthz` endpoint
// that runs a cheap `SELECT 1` against the pool so load
// balancers and orchestrators can detect database outages.
// Adds `/health`, `/status`, and `/metrics` for hosted
// deployments without claiming any value the API cannot observe.
//
// Splits cleanly so the routing + healthz logic is unit-testable
// without binding sockets:
//
//   - healthzResponse(pool)                → {status, body, contentType}
//   - operationalStatusResponse(pool, ctx) → {status, body, contentType}
//   - metricsResponse(pool)                → {status, body, contentType}
//   - createKasGraphHttpHandler(...)       → (req, res) => void
//   - runKasGraphServerFromEnv()          → ties everything together
//   - main()                              → CLI entry point

import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client, Pool } from 'pg';

import { createKasGraphServer, type KasGraphServer } from './server.js';
import { handleDeployRequest, type DeployAuthOptions } from './deploy-endpoint.js';
import type { PgPoolLike } from './pg-resolvers.js';
import { PgListenSource, type PgListenClient } from './pg-listen.js';
import { sanitizeLogLine } from './log-sanitize.js';

// ---------------------------------------------------------------
// Structured logging — JSON lines to stdout, errors to stderr.
// Operators that want a different format can pipe through `jq`
// or redirect.
// ---------------------------------------------------------------

function log(level: 'info' | 'warn' | 'error', message: string, extra?: Record<string, unknown>): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  });
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// ---------------------------------------------------------------
// Healthz
// ---------------------------------------------------------------

export interface HealthzResponse {
  status: number;
  body: string;
  contentType: string;
}

export interface OperationalStatusOptions {
  environment: string;
  network?: string;
  version: string;
}

interface CommittedBlockStatsRow {
  indexed_daa_score: string | null;
  indexed_blocks: string;
}

interface RpcAuditStatsRow {
  observed_daa_score: string | null;
  observed_blocks: string;
}

interface PoiStatsRow {
  latest_poi_checkpoint: Buffer | string | null;
  poi_checkpoints_total: string;
}

interface SubgraphStatsRow {
  subgraphs_deployed: string;
}

/**
 * Returns an OK response when `pool` accepts a trivial query,
 * 503 otherwise. Pool errors are surfaced in the body so
 * operators can read them from `curl` without grepping logs.
 */
export async function healthzResponse(pool: PgPoolLike): Promise<HealthzResponse> {
  try {
    await pool.query('SELECT 1');
    return {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok' }),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'unhealthy', error: message }),
    };
  }
}

function asNumber(value: string | null | undefined): number | null {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hexValue(value: Buffer | string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value.startsWith('0x')) return value;
  return value;
}

async function postgresConnected(pool: PgPoolLike): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

async function optionalQueryFirst<TRow extends object>(
  pool: PgPoolLike,
  sql: string,
): Promise<TRow | undefined> {
  try {
    const res = await pool.query(sql);
    return res.rows[0] as TRow | undefined;
  } catch {
    return undefined;
  }
}

async function committedBlockStats(pool: PgPoolLike): Promise<CommittedBlockStatsRow> {
  const row = await optionalQueryFirst<CommittedBlockStatsRow>(
    pool,
    `SELECT
       MAX(daa_score)::text AS indexed_daa_score,
       COUNT(*)::text AS indexed_blocks
     FROM kasgraph_committed_block`,
  );
  return row ?? { indexed_daa_score: null, indexed_blocks: '0' };
}

async function rpcAuditStats(pool: PgPoolLike): Promise<RpcAuditStatsRow> {
  const row = await optionalQueryFirst<RpcAuditStatsRow>(
    pool,
    `SELECT
       MAX(daa_score)::text AS observed_daa_score,
       COUNT(*)::text AS observed_blocks
     FROM kasgraph_rpc_block_audit`,
  );
  return row ?? { observed_daa_score: null, observed_blocks: '0' };
}

async function poiStats(pool: PgPoolLike): Promise<PoiStatsRow> {
  const row = await optionalQueryFirst<PoiStatsRow>(
    pool,
    `SELECT
       (SELECT poi_hash FROM kasgraph_poi ORDER BY block_daa_score DESC LIMIT 1) AS latest_poi_checkpoint,
       COUNT(*)::text AS poi_checkpoints_total
     FROM kasgraph_poi`,
  );
  return row ?? { latest_poi_checkpoint: null, poi_checkpoints_total: '0' };
}

async function subgraphStats(pool: PgPoolLike): Promise<SubgraphStatsRow> {
  const row = await optionalQueryFirst<SubgraphStatsRow>(
    pool,
    `SELECT COUNT(*)::text AS subgraphs_deployed
     FROM kasgraph_subgraph
     WHERE status <> 'removed'`,
  );
  return row ?? { subgraphs_deployed: '0' };
}

/**
 * Hosted-node status assembled only from values the API can observe.
 * RPC/indexer liveness is reported as unavailable here because the
 * GraphQL gateway process does not own the Kaspa RPC connection.
 */
export async function operationalStatusResponse(
  pool: PgPoolLike,
  options: OperationalStatusOptions,
): Promise<HealthzResponse> {
  const connected = await postgresConnected(pool);
  const [blocks, audit, poi, subgraphs] = connected
    ? await Promise.all([committedBlockStats(pool), rpcAuditStats(pool), poiStats(pool), subgraphStats(pool)])
    : [
        { indexed_daa_score: null, indexed_blocks: '0' },
        { observed_daa_score: null, observed_blocks: '0' },
        { latest_poi_checkpoint: null, poi_checkpoints_total: '0' },
        { subgraphs_deployed: '0' },
      ];

  return {
    status: connected ? 200 : 503,
    contentType: 'application/json',
    body: JSON.stringify({
      status: connected ? 'ok' : 'degraded',
      environment: options.environment,
      network: options.network ?? null,
      indexedDaaScore: blocks.indexed_daa_score,
      indexedBlocks: asNumber(blocks.indexed_blocks),
      observedDaaScore: audit.observed_daa_score,
      observedBlocks: asNumber(audit.observed_blocks),
      rpcConnected: 'unavailable',
      postgresConnected: connected,
      latestPoiCheckpoint: hexValue(poi.latest_poi_checkpoint),
      poiCheckpointsTotal: asNumber(poi.poi_checkpoints_total),
      subgraphsDeployed: asNumber(subgraphs.subgraphs_deployed),
      version: options.version,
      updatedAt: new Date().toISOString(),
    }),
  };
}

/**
 * Prometheus-compatible text metrics for the API process and the
 * Postgres-backed registry tables. Missing tables stay at zero so a
 * fresh deployment can be scraped before migrations/indexing are live.
 */
export async function metricsResponse(pool: PgPoolLike): Promise<HealthzResponse> {
  const connected = await postgresConnected(pool);
  const [blocks, audit, poi, subgraphs] = connected
    ? await Promise.all([committedBlockStats(pool), rpcAuditStats(pool), poiStats(pool), subgraphStats(pool)])
    : [
        { indexed_daa_score: null, indexed_blocks: '0' },
        { observed_daa_score: null, observed_blocks: '0' },
        { latest_poi_checkpoint: null, poi_checkpoints_total: '0' },
        { subgraphs_deployed: '0' },
      ];
  const memory = process.memoryUsage();
  const lines = [
    '# HELP kasgraph_postgres_connected 1 when Postgres accepts SELECT 1, else 0.',
    '# TYPE kasgraph_postgres_connected gauge',
    `kasgraph_postgres_connected ${connected ? 1 : 0}`,
    '# HELP kasgraph_indexed_blocks_total Committed block rows visible to the API.',
    '# TYPE kasgraph_indexed_blocks_total gauge',
    `kasgraph_indexed_blocks_total ${asNumber(blocks.indexed_blocks) ?? 0}`,
    '# HELP kasgraph_indexed_daa_score Highest committed DAA score visible to the API.',
    '# TYPE kasgraph_indexed_daa_score gauge',
    `kasgraph_indexed_daa_score ${asNumber(blocks.indexed_daa_score) ?? 0}`,
    '# HELP kasgraph_observed_blocks_total RPC block audit rows received by the indexer.',
    '# TYPE kasgraph_observed_blocks_total gauge',
    `kasgraph_observed_blocks_total ${asNumber(audit.observed_blocks) ?? 0}`,
    '# HELP kasgraph_observed_daa_score Highest RPC block DAA observed by the indexer.',
    '# TYPE kasgraph_observed_daa_score gauge',
    `kasgraph_observed_daa_score ${asNumber(audit.observed_daa_score) ?? 0}`,
    '# HELP kasgraph_poi_checkpoints_total POI checkpoint rows visible to the API.',
    '# TYPE kasgraph_poi_checkpoints_total gauge',
    `kasgraph_poi_checkpoints_total ${asNumber(poi.poi_checkpoints_total) ?? 0}`,
    '# HELP kasgraph_subgraphs_deployed Active subgraphs visible to the API.',
    '# TYPE kasgraph_subgraphs_deployed gauge',
    `kasgraph_subgraphs_deployed ${asNumber(subgraphs.subgraphs_deployed) ?? 0}`,
    '# HELP kasgraph_process_memory_rss_bytes Resident set size of the API process.',
    '# TYPE kasgraph_process_memory_rss_bytes gauge',
    `kasgraph_process_memory_rss_bytes ${memory.rss}`,
  ];
  return {
    status: connected ? 200 : 503,
    contentType: 'text/plain; version=0.0.4',
    body: `${lines.join('\n')}\n`,
  };
}

// ---------------------------------------------------------------
// Live soak monitoring
// ---------------------------------------------------------------

export interface SoakMonitorOptions extends OperationalStatusOptions {
  artifactDir: string;
  kaspadRpcUrl?: string;
}

type SoakStatusValue = 'pending' | 'active' | 'running' | 'degraded' | 'completed' | 'failed' | 'offline';
const SOAK_COMPLETION_TARGET_SECONDS = 24 * 60 * 60;

interface SoakSummaryFile {
  status?: SoakStatusValue;
  environment?: string;
  network?: string;
  startedAt?: string;
  updatedAt?: string;
  durationSeconds?: number;
  commit?: string;
  version?: string;
  daaStart?: string | number | null;
  transactionsIndexed?: number | null;
  entitiesWritten?: number | null;
  rpcConnected?: boolean | null;
  graphqlHealthy?: boolean | null;
  mcpHealthy?: boolean | null;
  websocketHealthy?: boolean | null;
  knownIssues?: string[];
  restartRecovery?: string | null;
}

interface KaspadStatus {
  connected: boolean;
  serverVersion: string | null;
  isSynced: boolean | null;
  virtualDaaScore: string | null;
  networkId: string | null;
  phase: string | null;
  blockCount: string | null;
  headerCount: string | null;
  pruningPointHash: string | null;
  sinkHash: string | null;
  tipCount: number | null;
  virtualParentCount: number | null;
  peerCount: number | null;
  ibdPeerCount: number | null;
  protocolVersion10Peers: number | null;
  protocolVersion9Peers: number | null;
  lastPingMsMax: number | null;
  error?: string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function readLines(filePath: string, tail: number): string[] {
  try {
    if (!existsSync(filePath)) return [];
    const lines = readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
    return lines.slice(Math.max(0, lines.length - tail));
  } catch {
    return [];
  }
}

function delta(start: string | number | null | undefined, current: string | null): string | null {
  if (start === undefined || start === null || current === null) return null;
  try {
    const s = BigInt(String(start));
    const c = BigInt(current);
    return String(c - s);
  } catch {
    return null;
  }
}

function soakElapsedSeconds(startedAt: string | null, fallback: number | undefined): number | null {
  if (startedAt === null) return null;
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return fallback ?? null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function soakTargetReachedAt(startedAt: string | null): string | null {
  if (startedAt === null) return null;
  const parsed = Date.parse(startedAt);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + SOAK_COMPLETION_TARGET_SECONDS * 1000).toISOString();
}

type KaspadRpcBody = Record<string, unknown>;

function emptyKaspadStatus(error?: string): KaspadStatus {
  return {
    connected: false,
    serverVersion: null,
    isSynced: null,
    virtualDaaScore: null,
    networkId: null,
    phase: null,
    blockCount: null,
    headerCount: null,
    pruningPointHash: null,
    sinkHash: null,
    tipCount: null,
    virtualParentCount: null,
    peerCount: null,
    ibdPeerCount: null,
    protocolVersion10Peers: null,
    protocolVersion9Peers: null,
    lastPingMsMax: null,
    ...(error !== undefined && { error }),
  };
}

function stringField(body: KaspadRpcBody | null, field: string): string | null {
  const value = body?.[field];
  return value === undefined || value === null ? null : String(value);
}

function booleanField(body: KaspadRpcBody | null, field: string): boolean | null {
  const value = body?.[field];
  return typeof value === 'boolean' ? value : null;
}

function arrayLengthField(body: KaspadRpcBody | null, field: string): number | null {
  const value = body?.[field];
  return Array.isArray(value) ? value.length : null;
}

async function kaspadRpcCall(rpcUrl: string, method: string, timeoutMs = 2500): Promise<KaspadRpcBody> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(rpcUrl);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // Ignore close failures during timeout cleanup.
      }
      reject(new Error(`${method} timeout`));
    }, timeoutMs);

    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // The socket may already be closed.
      }
      fn();
    };

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ id: 1, method, params: {} }));
    });
    ws.addEventListener('message', (event) => {
      finish(() => {
        try {
          const payload = JSON.parse(String(event.data)) as {
            params?: KaspadRpcBody;
            result?: KaspadRpcBody;
            error?: unknown;
          };
          const body = payload.params ?? payload.result;
          if (body === undefined) {
            reject(new Error(payload.error === undefined ? `${method} empty RPC response` : String(payload.error)));
            return;
          }
          resolve(body);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    ws.addEventListener('error', () => {
      finish(() => reject(new Error(`${method} connection error`)));
    });
  });
}

function kaspadPhase(server: KaspadRpcBody | null, dag: KaspadRpcBody | null): string | null {
  const isSynced = booleanField(server, 'isSynced');
  const daa = stringField(server, 'virtualDaaScore') ?? stringField(dag, 'virtualDaaScore');
  const blockCount = stringField(dag, 'blockCount');
  const headerCount = stringField(dag, 'headerCount');
  if (isSynced === true) return 'synced';
  if (daa === '0' && blockCount === '0' && headerCount !== null && headerCount !== '0') {
    return 'pruning point / UTXO import';
  }
  if (daa === '0') return 'initial block download';
  return 'syncing live DAG';
}

async function kaspadStatus(rpcUrl: string | undefined): Promise<KaspadStatus | null> {
  if (rpcUrl === undefined || rpcUrl.length === 0 || typeof WebSocket === 'undefined') return null;

  try {
    const [server, dag, peers] = await Promise.all([
      kaspadRpcCall(rpcUrl, 'getServerInfo'),
      kaspadRpcCall(rpcUrl, 'getBlockDagInfo'),
      kaspadRpcCall(rpcUrl, 'getConnectedPeerInfo').catch(() => null),
    ]);
    const peerInfo = peers?.peerInfo;
    const peerRows = Array.isArray(peerInfo) ? (peerInfo as Array<Record<string, unknown>>) : [];
    const lastPingMs = peerRows
      .map((peer) => Number(peer.last_ping_duration))
      .filter((value) => Number.isFinite(value));
    const serverDaa = stringField(server, 'virtualDaaScore');
    const dagDaa = stringField(dag, 'virtualDaaScore');

    return {
      connected: true,
      serverVersion: stringField(server, 'serverVersion'),
      isSynced: booleanField(server, 'isSynced'),
      virtualDaaScore: serverDaa ?? dagDaa,
      networkId: stringField(server, 'networkId') ?? stringField(dag, 'network'),
      phase: kaspadPhase(server, dag),
      blockCount: stringField(dag, 'blockCount'),
      headerCount: stringField(dag, 'headerCount'),
      pruningPointHash: stringField(dag, 'pruningPointHash'),
      sinkHash: stringField(dag, 'sink'),
      tipCount: arrayLengthField(dag, 'tipHashes'),
      virtualParentCount: arrayLengthField(dag, 'virtualParentHashes'),
      peerCount: peerRows.length,
      ibdPeerCount: peerRows.filter((peer) => peer.is_ibd_peer === true).length,
      protocolVersion10Peers: peerRows.filter((peer) => peer.advertised_protocol_version === 10).length,
      protocolVersion9Peers: peerRows.filter((peer) => peer.advertised_protocol_version === 9).length,
      lastPingMsMax: lastPingMs.length === 0 ? null : Math.max(...lastPingMs),
    };
  } catch (err) {
    return emptyKaspadStatus(err instanceof Error ? err.message : String(err));
  }
}

async function soakStatusBody(
  pool: PgPoolLike,
  options: SoakMonitorOptions,
): Promise<Record<string, unknown>> {
  const summary = readJsonFile<SoakSummaryFile>(path.join(options.artifactDir, 'summary.json'));
  const connected = await postgresConnected(pool);
  const [blocks, audit, poi] = connected
    ? await Promise.all([committedBlockStats(pool), rpcAuditStats(pool), poiStats(pool)])
    : [
        { indexed_daa_score: null, indexed_blocks: '0' },
        { observed_daa_score: null, observed_blocks: '0' },
        { latest_poi_checkpoint: null, poi_checkpoints_total: '0' },
      ];
  const kaspad = await kaspadStatus(options.kaspadRpcUrl);
  const updatedAt = new Date().toISOString();
  const startedAt = summary?.startedAt ?? null;
  const sourceStatus: SoakStatusValue = summary?.status ?? 'pending';
  const isActiveRun = sourceStatus === 'active' || sourceStatus === 'running' || sourceStatus === 'degraded';
  const durationSeconds =
    isActiveRun ? soakElapsedSeconds(startedAt, summary?.durationSeconds) : (summary?.durationSeconds ?? soakElapsedSeconds(startedAt, undefined));
  const indexedDaaDelta = delta(summary?.daaStart, blocks.indexed_daa_score);
  const observedRpcDaaDelta = delta(summary?.daaStart, audit.observed_daa_score);
  const kaspadDaaDelta = delta(summary?.daaStart, kaspad?.virtualDaaScore ?? null);
  const targetReached = sourceStatus !== 'failed' && (durationSeconds ?? 0) >= SOAK_COMPLETION_TARGET_SECONDS;
  const status: SoakStatusValue = targetReached ? 'completed' : sourceStatus;
  const completionStatus = targetReached ? 'success' : sourceStatus === 'failed' ? 'failed' : 'in_progress';
  const verdict = targetReached
    ? 'Success: 24-hour testnet soak target reached.'
    : sourceStatus === 'failed'
      ? 'Failed: soak run did not complete successfully.'
      : 'Incomplete: 24-hour testnet soak target has not been reached.';

  return {
    status,
    sourceStatus,
    completionStatus,
    verdict,
    targetDurationSeconds: SOAK_COMPLETION_TARGET_SECONDS,
    targetReached,
    environment: summary?.environment ?? options.environment,
    network: summary?.network ?? options.network ?? null,
    startedAt,
    endedAt: targetReached ? (summary?.updatedAt ?? soakTargetReachedAt(startedAt) ?? updatedAt) : null,
    targetReachedAt: targetReached ? soakTargetReachedAt(startedAt) : null,
    updatedAt: isActiveRun ? updatedAt : (summary?.updatedAt ?? updatedAt),
    durationSeconds,
    commit: summary?.commit ?? null,
    version: summary?.version ?? options.version,
    indexedDaaScore: blocks.indexed_daa_score,
    daaStart: summary?.daaStart ?? null,
    daaDelta: indexedDaaDelta,
    indexedDaaDelta,
    indexedBlocks: asNumber(blocks.indexed_blocks),
    observedDaaScore: audit.observed_daa_score,
    observedRpcDaaDelta,
    observedBlocks: asNumber(audit.observed_blocks),
    kaspadConnected: kaspad?.connected ?? null,
    kaspadVersion: kaspad?.serverVersion ?? null,
    kaspadSynced: kaspad?.isSynced ?? null,
    kaspadDaaScore: kaspad?.virtualDaaScore ?? null,
    kaspadDaaDelta,
    kaspadNetworkId: kaspad?.networkId ?? null,
    kaspadPhase: kaspad?.phase ?? null,
    kaspadBlockCount: kaspad?.blockCount ?? null,
    kaspadHeaderCount: kaspad?.headerCount ?? null,
    kaspadPruningPointHash: kaspad?.pruningPointHash ?? null,
    kaspadSinkHash: kaspad?.sinkHash ?? null,
    kaspadTipCount: kaspad?.tipCount ?? null,
    kaspadVirtualParentCount: kaspad?.virtualParentCount ?? null,
    kaspadPeerCount: kaspad?.peerCount ?? null,
    kaspadIbdPeerCount: kaspad?.ibdPeerCount ?? null,
    kaspadProtocolVersion10Peers: kaspad?.protocolVersion10Peers ?? null,
    kaspadProtocolVersion9Peers: kaspad?.protocolVersion9Peers ?? null,
    kaspadLastPingMsMax: kaspad?.lastPingMsMax ?? null,
    kaspadError: kaspad?.error ?? null,
    transactionsIndexed: summary?.transactionsIndexed ?? null,
    entitiesWritten: summary?.entitiesWritten ?? null,
    latestPoiCheckpoint: hexValue(poi.latest_poi_checkpoint),
    poiCheckpointsTotal: asNumber(poi.poi_checkpoints_total),
    rpcConnected: summary?.rpcConnected ?? kaspad?.connected ?? null,
    postgresConnected: connected,
    graphqlHealthy: summary?.graphqlHealthy ?? null,
    mcpHealthy: summary?.mcpHealthy ?? null,
    websocketHealthy: summary?.websocketHealthy ?? null,
    restartRecovery: summary?.restartRecovery ?? null,
    knownIssues: summary?.knownIssues ?? [],
  };
}

export async function soakStatusResponse(
  pool: PgPoolLike,
  options: SoakMonitorOptions,
): Promise<HealthzResponse> {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(await soakStatusBody(pool, options)),
  };
}

export async function soakMetricsResponse(
  pool: PgPoolLike,
  options: SoakMonitorOptions,
): Promise<HealthzResponse> {
  const status = await soakStatusBody(pool, options);
  const resourceLines = readLines(path.join(options.artifactDir, 'public-resource-metrics.jsonl'), 1);
  const dbLines = readLines(path.join(options.artifactDir, 'public-db-stats.jsonl'), 1);
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      status,
      resource: resourceLines[0] === undefined ? null : JSON.parse(resourceLines[0]),
      db: dbLines[0] === undefined ? null : JSON.parse(dbLines[0]),
    }),
  };
}

export async function soakSummaryResponse(
  pool: PgPoolLike,
  options: SoakMonitorOptions,
): Promise<HealthzResponse> {
  return soakStatusResponse(pool, options);
}

function soakDashboardResponse(): HealthzResponse {
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KasGraph Live Soak</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #06110f;
      --panel: #0b1a17;
      --line: rgba(112, 199, 186, 0.22);
      --text: #eefefa;
      --muted: #9bb3ae;
      --accent: #49eacb;
      --warn: #f7c66a;
      --bad: #ff7b7b;
      --ok: #66e6a3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top left, rgba(73, 234, 203, 0.12), transparent 34rem), var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main { width: min(1180px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
    h1 { margin: 0; font-size: clamp(2rem, 4vw, 4rem); letter-spacing: -0.03em; }
    p { color: var(--muted); line-height: 1.6; }
    a { color: var(--accent); }
    .eyebrow, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .eyebrow { color: var(--accent); text-transform: uppercase; font-size: 12px; letter-spacing: 0.22em; margin-bottom: 12px; }
    .pill { border: 1px solid var(--line); border-radius: 999px; padding: 8px 12px; color: var(--accent); white-space: nowrap; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
    .panel, .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(11, 26, 23, 0.78);
      box-shadow: 0 20px 70px rgba(0, 0, 0, 0.24);
    }
    .panel { padding: 20px; margin-top: 16px; }
    .card { padding: 16px; min-height: 92px; }
    .label { color: #70c7ba; text-transform: uppercase; font-size: 11px; letter-spacing: 0.16em; }
    .value { margin-top: 10px; overflow-wrap: anywhere; font-size: 15px; }
    .value.big { font-size: 22px; font-weight: 700; }
    .status-ok, .status-active, .status-begun { color: var(--ok); }
    .status-degraded { color: var(--warn); }
    .status-offline, .status-failed { color: var(--bad); }
    .bar { height: 10px; background: rgba(0, 0, 0, 0.38); border-radius: 999px; overflow: hidden; }
    .bar > div { height: 100%; width: 0%; background: var(--accent); transition: width 250ms ease; }
    pre {
      margin: 0;
      max-height: 380px;
      overflow: auto;
      white-space: pre-wrap;
      color: #d8fff7;
      font-size: 12px;
      line-height: 1.55;
    }
    .two { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 16px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    button {
      border: 1px solid rgba(73, 234, 203, 0.38);
      color: var(--text);
      background: rgba(0, 0, 0, 0.28);
      border-radius: 6px;
      padding: 9px 12px;
      cursor: pointer;
    }
    @media (max-width: 920px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .two { grid-template-columns: 1fr; } header { flex-direction: column; } }
    @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } main { width: min(100% - 20px, 1180px); } }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">kasgraph live soak</div>
        <h1>Testnet Soak Dashboard</h1>
        <p>Local operator view served directly by the KasGraph API. It refreshes from <span class="mono">/soak/status</span> and streams <span class="mono">/soak/events</span> when available.</p>
      </div>
      <div class="pill mono" id="connection">connecting</div>
    </header>

    <section class="grid" id="cards"></section>

    <section class="panel">
      <div class="label">24h soak progress</div>
      <div class="bar" style="margin-top: 14px"><div id="progress"></div></div>
      <p id="progressText">Waiting for status...</p>
      <div class="actions">
        <button type="button" id="refresh">Refresh now</button>
        <a href="/soak/status">JSON status</a>
        <a href="/status">API status</a>
        <a href="/graphql">GraphQL</a>
        <a href="/metrics">Metrics</a>
      </div>
    </section>

    <section class="two">
      <div class="panel">
        <div class="label">sanitized logs</div>
        <pre id="logs">Loading logs...</pre>
      </div>
      <div class="panel">
        <div class="label">known issues</div>
        <pre id="issues">Loading issues...</pre>
      </div>
    </section>
  </main>

  <script>
    const cards = document.getElementById('cards');
    const progress = document.getElementById('progress');
    const progressText = document.getElementById('progressText');
    const connection = document.getElementById('connection');
    const logs = document.getElementById('logs');
    const issues = document.getElementById('issues');
    const refresh = document.getElementById('refresh');
    const runtimeTarget = 24 * 60 * 60;

    function value(v, fallback = 'Unavailable') {
      if (v === null || v === undefined || v === '') return fallback;
      return String(v);
    }

    function duration(seconds) {
      if (seconds === null || seconds === undefined) return 'Unavailable';
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return h + 'h ' + m + 'm';
    }

    function card(label, val, big = false, className = '') {
      return '<article class="card"><div class="label">' + label + '</div><div class="value ' + (big ? 'big ' : '') + className + '">' + value(val) + '</div></article>';
    }

    function syncedAndMoving(s) {
      const delta = Number(s.daaDelta);
      return s.status === 'active' && (s.kaspadSynced === true || delta > 0);
    }

    function displayStatus(s) {
      if (s.targetReached === true || s.status === 'completed') return 'completed';
      return syncedAndMoving(s) ? 'begun' : s.status;
    }

    function renderStatus(s) {
      const shownStatus = displayStatus(s);
      const statusClass = 'status-' + value(shownStatus, 'pending');
      cards.innerHTML = [
        card('Soak status', shownStatus, true, statusClass),
        card('Completion', s.completionStatus),
        card('Verdict', s.verdict),
        card('Network', s.network),
        card('Runtime', duration(s.durationSeconds)),
        card('Indexed DAA', s.indexedDaaScore),
        card('Indexed DAA delta', s.indexedDaaDelta ?? s.daaDelta),
        card('Indexed blocks', s.indexedBlocks),
        card('Observed RPC DAA', s.observedDaaScore),
        card('Observed RPC DAA delta', s.observedRpcDaaDelta),
        card('Observed RPC blocks', s.observedBlocks),
        card('Kaspad version', s.kaspadVersion),
        card('Kaspad synced', s.kaspadSynced),
        card('Kaspad DAA', s.kaspadDaaScore),
        card('Kaspad DAA delta', s.kaspadDaaDelta),
        card('Kaspad network', s.kaspadNetworkId),
        card('Kaspad phase', s.kaspadPhase),
        card('Kaspad headers', s.kaspadHeaderCount),
        card('Kaspad blocks', s.kaspadBlockCount),
        card('Kaspad peers', s.kaspadPeerCount),
        card('Kaspad IBD peers', s.kaspadIbdPeerCount),
        card('Protocol v10 peers', s.kaspadProtocolVersion10Peers),
        card('Protocol v9 peers', s.kaspadProtocolVersion9Peers),
        card('Max peer ping ms', s.kaspadLastPingMsMax),
        card('Tip count', s.kaspadTipCount),
        card('Virtual parents', s.kaspadVirtualParentCount),
        card('Pruning point', s.kaspadPruningPointHash),
        card('Latest POI', s.latestPoiCheckpoint),
        card('API health', s.graphqlHealthy),
        card('Postgres', s.postgresConnected),
        card('Updated', s.updatedAt)
      ].join('');

      const pct = Math.min(100, Math.round(((s.durationSeconds || 0) / runtimeTarget) * 100));
      progress.style.width = pct + '%';
      progressText.textContent = pct + '% of 24h target. Started ' + value(s.startedAt) + '.';
      issues.textContent = (s.knownIssues && s.knownIssues.length > 0) ? s.knownIssues.join('\\n') : 'None reported.';
    }

    async function loadStatus() {
      const res = await fetch('/soak/status', { cache: 'no-store' });
      const body = await res.json();
      renderStatus(body);
      connection.textContent = res.ok ? 'connected' : 'degraded';
    }

    async function loadLogs() {
      const res = await fetch('/soak/logs?tail=80', { cache: 'no-store' });
      const body = await res.json();
      logs.textContent = body.logs && body.logs.length > 0 ? body.logs.join('\\n') : 'No public sanitized logs available.';
    }

    async function refreshAll() {
      try {
        await Promise.all([loadStatus(), loadLogs()]);
      } catch (err) {
        connection.textContent = 'offline';
        issues.textContent = String(err);
      }
    }

    refresh.addEventListener('click', refreshAll);
    refreshAll();
    setInterval(refreshAll, 10000);

    if (typeof EventSource !== 'undefined') {
      const events = new EventSource('/soak/events');
      events.addEventListener('soak_status', (event) => {
        renderStatus(JSON.parse(event.data));
        connection.textContent = 'streaming';
      });
      events.onerror = () => {
        connection.textContent = 'polling fallback';
      };
    }
  </script>
</body>
</html>`,
  };
}

export function soakLogsResponse(req: IncomingMessage, options: SoakMonitorOptions): HealthzResponse {
  const url = new URL(req.url ?? '/soak/logs', 'http://localhost');
  const tail = Math.min(Math.max(Number.parseInt(url.searchParams.get('tail') ?? '100', 10), 1), 500);
  const level = url.searchParams.get('level');
  const format = url.searchParams.get('format') ?? 'json';
  const lines = readLines(path.join(options.artifactDir, 'public-log-tail.jsonl'), tail)
    .map((line) => sanitizeLogLine(line))
    .filter((line) => {
      if (level === null) return true;
      try {
        const parsed = JSON.parse(line) as { level?: unknown };
        return parsed.level === level;
      } catch {
        return line.includes(`"level":"${level}"`) || line.includes(`level=${level}`);
      }
    });
  return {
    status: 200,
    contentType: format === 'jsonl' ? 'application/x-ndjson' : 'application/json',
    body: format === 'jsonl' ? `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}` : JSON.stringify({ logs: lines }),
  };
}

export function nodeSoakHandler(pool: PgPoolLike, options: SoakMonitorOptions): NodeHttpHandler {
  return (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' });
      res.end();
      return;
    }
    if (pathname === '/soak/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let closed = false;
      req.on('close', () => {
        closed = true;
      });
      const writeStatus = (): void => {
        if (closed) return;
        soakStatusBody(pool, options)
          .then((body) => {
            res.write(`event: soak_status\n`);
            res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), ...body })}\n\n`);
          })
          .catch((err: unknown) => {
            res.write(`event: error\n`);
            res.write(`data: ${JSON.stringify({ timestamp: new Date().toISOString(), error: String(err) })}\n\n`);
          });
      };
      writeStatus();
      const timer = setInterval(writeStatus, 5000);
      req.on('close', () => clearInterval(timer));
      return;
    }

    const respond = (response: HealthzResponse): void => {
      res.writeHead(response.status, { 'content-type': response.contentType });
      res.end(req.method === 'HEAD' ? undefined : response.body);
    };

    if (pathname === '/soak' || pathname === '/soak/') {
      respond(soakDashboardResponse());
      return;
    }
    if (pathname === '/soak/status') {
      void soakStatusResponse(pool, options).then(respond);
      return;
    }
    if (pathname === '/soak/metrics') {
      void soakMetricsResponse(pool, options).then(respond);
      return;
    }
    if (pathname === '/soak/summary') {
      void soakSummaryResponse(pool, options).then(respond);
      return;
    }
    if (pathname === '/soak/logs') {
      respond(soakLogsResponse(req, options));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  };
}

// ---------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------

export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => void;
export type HealthCheck = () => Promise<HealthzResponse>;

export interface HttpHandlerOptions {
  corsAllowedOrigins?: readonly string[];
  rateLimitPerMinute?: number;
}

type RateLimitBucket = { minute: number; count: number };

function pathMatches(url: string, path: string): boolean {
  return url === path || url.startsWith(`${path}?`);
}

function writeOperationalResponse(
  req: IncomingMessage,
  res: ServerResponse,
  check: HealthCheck,
): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end();
    return;
  }
  check()
    .then(({ status, body, contentType }) => {
      res.writeHead(status, { 'content-type': contentType });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        res.end(body);
      }
    })
    .catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    });
}

/**
 * A Node-http handler for the hosted-node deploy endpoint (`/subgraphs*`):
 * reads the JSON body (if any), delegates to the pure `handleDeployRequest`,
 * and writes the JSON response. This is the server side of
 * `kasgraph deploy --node <url>`.
 */
export function nodeDeployHandler(pool: PgPoolLike, auth: DeployAuthOptions = {}): NodeHttpHandler {
  return (req, res) => {
    const authorization = req.headers.authorization;
    if (
      auth.bearerToken !== undefined &&
      auth.bearerToken.length > 0 &&
      (req.method === 'POST' || req.method === 'DELETE') &&
      authorization !== `Bearer ${auth.bearerToken}`
    ) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: unknown;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
      }
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      handleDeployRequest(
        {
          method: req.method ?? 'GET',
          path: pathname,
          body,
          ...(authorization !== undefined && { authorization }),
        },
        pool,
        auth,
      )
        .then(({ status, body: out }) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(out));
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        });
    });
  };
}

/**
 * Build a Node-http handler that routes `GET /healthz` to the
 * supplied `healthCheck`, `/subgraphs*` to the optional deploy
 * handler (the hosted-node deploy endpoint), and forwards
 * everything else to the Yoga handler. Yoga itself is a Fetch-API
 * function callable directly as a Node request listener.
 */
export function createKasGraphHttpHandler(
  yoga: KasGraphServer,
  healthCheck: HealthCheck,
  deployHandler?: NodeHttpHandler,
  statusCheck?: HealthCheck,
  metricsCheck?: HealthCheck,
  options: HttpHandlerOptions = {},
  soakHandler?: NodeHttpHandler,
): NodeHttpHandler {
  const buckets = new Map<string, RateLimitBucket>();
  return (req, res) => {
    const url = req.url ?? '/';
    applyCors(req, res, options.corsAllowedOrigins ?? []);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!allowRequest(req, options.rateLimitPerMinute ?? 0, buckets)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate limit exceeded' }));
      return;
    }
    if ((url === '/' || url.startsWith('/?')) && soakHandler !== undefined) {
      const originalUrl = req.url;
      req.url = '/soak';
      soakHandler(req, res);
      req.url = originalUrl;
      return;
    }
    if (
      deployHandler !== undefined &&
      (url === '/subgraphs' || url.startsWith('/subgraphs/') || url.startsWith('/subgraphs?'))
    ) {
      deployHandler(req, res);
      return;
    }
    if (soakHandler !== undefined && (url === '/soak' || url.startsWith('/soak/'))) {
      soakHandler(req, res);
      return;
    }
    if (pathMatches(url, '/healthz') || pathMatches(url, '/health')) {
      // Always allow GET + HEAD on healthz; anything else is
      // 405 so operators don't accidentally POST to the wrong
      // path and get confusing GraphQL errors back.
      writeOperationalResponse(req, res, healthCheck);
      return;
    }
    if (statusCheck !== undefined && pathMatches(url, '/status')) {
      writeOperationalResponse(req, res, statusCheck);
      return;
    }
    if (metricsCheck !== undefined && pathMatches(url, '/metrics')) {
      writeOperationalResponse(req, res, metricsCheck);
      return;
    }

    // Yoga's server instance is callable as a Node http request
    // listener directly.
    (yoga as unknown as NodeHttpHandler)(req, res);
  };
}

function applyCors(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigins: readonly string[],
): void {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && allowedOrigins.includes(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'origin');
    res.setHeader('access-control-allow-methods', 'GET, HEAD, POST, OPTIONS, DELETE');
    res.setHeader('access-control-allow-headers', 'content-type, authorization');
  }
}

function allowRequest(
  req: IncomingMessage,
  rateLimitPerMinute: number,
  buckets: Map<string, RateLimitBucket>,
): boolean {
  if (rateLimitPerMinute <= 0) return true;
  const key = req.socket.remoteAddress ?? 'unknown';
  const minute = Math.floor(Date.now() / 60_000);
  const bucket = buckets.get(key);
  if (bucket === undefined || bucket.minute !== minute) {
    buckets.set(key, { minute, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= rateLimitPerMinute;
}

// ---------------------------------------------------------------
// Env-driven entry
// ---------------------------------------------------------------

export interface RunServerOptions {
  /** Set explicitly in tests. Production reads from env. */
  databaseUrl: string;
  host: string;
  port: number;
  graphqlEndpoint: string;
  graphiql: boolean;
  /**
   * Enable GraphQL `Subscription.detectedPatterns` over the
   * Postgres LISTEN/NOTIFY channel. When `false`, the gateway
   * starts without a subscription source; subscribe calls
   * surface a clear "subscriptions are not configured" error.
   */
  subscriptionsEnabled: boolean;
  /**
   * Connection string for the dedicated listener client. Defaults
   * to `databaseUrl` so a single env var is enough in the common
   * case; operators that want to point listens at a read replica
   * (or a different role with NOTIFY privileges) override this.
   */
  listenDatabaseUrl: string;
  /** Bearer token required for hosted deploy/remove writes. */
  deployToken?: string;
  /** Human-readable deployment environment label, e.g. local/testnet/mainnet. */
  environment: string;
  /** Kaspa network served by this deployment when known. */
  network?: string;
  /** API version shown on `/status`. */
  version: string;
  /** Allowed browser origins for public read endpoints. */
  corsAllowedOrigins: string[];
  /** Simple per-IP HTTP request cap. 0 disables it. */
  rateLimitPerMinute: number;
  /** Directory containing live public soak artifacts. */
  soakArtifactDir: string;
  /** Optional JSON-wRPC URL for the kaspad backing live soak status. */
  kaspadRpcUrl?: string;
}

function envBoolean(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return ['1', 'true', 'TRUE', 'True', 'yes'].includes(v);
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function readOptionsFromEnv(): RunServerOptions {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.KASGRAPH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL (or KASGRAPH_DATABASE_URL) must be set so the gateway can connect to Postgres',
    );
  }
  const listenDatabaseUrl = process.env.LISTEN_DATABASE_URL ?? databaseUrl;
  const deployToken = process.env.KASGRAPH_DEPLOY_TOKEN;
  const network = process.env.KASGRAPH_NETWORK;
  const kaspadRpcUrl = process.env.KASGRAPH_KASPAD_RPC_URL ?? process.env.KASGRAPH_RPC_PRIMARY_URL;
  return {
    databaseUrl,
    host: process.env.HOST ?? '0.0.0.0',
    port: envInt('PORT', 4000),
    graphqlEndpoint: process.env.GRAPHQL_ENDPOINT ?? '/graphql',
    graphiql: envBoolean('GRAPHIQL', true),
    subscriptionsEnabled: envBoolean('KASGRAPH_SUBSCRIPTIONS_ENABLED', true),
    listenDatabaseUrl,
    environment: process.env.KASGRAPH_ENVIRONMENT ?? 'local',
    version: process.env.KASGRAPH_API_VERSION ?? '0.1.0',
    corsAllowedOrigins: (process.env.KASGRAPH_CORS_ORIGINS ??
      'https://www.kasgraph.com,https://kasgraph.com,http://localhost:3000,http://127.0.0.1:3000')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    rateLimitPerMinute: envInt('KASGRAPH_RATE_LIMIT_PER_MINUTE', 0),
    soakArtifactDir:
      process.env.KASGRAPH_SOAK_ARTIFACT_DIR ??
      new URL('../../docs/artifacts/sustained-run/live', import.meta.url).pathname,
    ...(deployToken !== undefined && deployToken.length > 0 && { deployToken }),
    ...(network !== undefined && network.length > 0 && { network }),
    ...(kaspadRpcUrl !== undefined && kaspadRpcUrl.length > 0 && { kaspadRpcUrl }),
  };
}

export interface RunningServer {
  /** Address the server actually bound to (port may be 0 → assigned). */
  address: { host: string; port: number };
  /** Stop the server and release pool connections. */
  shutdown(): Promise<void>;
}

/**
 * Start the gateway. Returns once the server is listening on
 * `options.host:options.port`. The returned `shutdown` cleanly
 * closes the http server and ends the pool.
 */
export async function runKasGraphServer(options: RunServerOptions): Promise<RunningServer> {
  const pool = new Pool({ connectionString: options.databaseUrl });

  // Build the LISTEN/NOTIFY-backed subscription source when
  // enabled. The connect factory returns a fresh dedicated
  // client every time PgListenSource lazy-reconnects.
  const subscriptionSource = options.subscriptionsEnabled
    ? new PgListenSource({
        connect: async () => {
          const client = new Client({ connectionString: options.listenDatabaseUrl });
          // `pg.Client` shape satisfies our PgListenClient
          // interface; cast through unknown to drop the extra
          // signatures pg exposes (parameterised query
          // overloads, events we don't subscribe to, etc.).
          return client as unknown as PgListenClient;
        },
        onError: (message, err) => {
          log('warn', `PgListenSource: ${message}`, {
            error: err === undefined ? undefined : String(err),
          });
        },
      })
    : undefined;

  const yoga = createKasGraphServer({
    pool,
    graphqlEndpoint: options.graphqlEndpoint,
    graphiql: options.graphiql,
    ...(subscriptionSource !== undefined && { subscriptionSource }),
  });
  const handler = createKasGraphHttpHandler(
    yoga,
    () => healthzResponse(pool),
    nodeDeployHandler(
      pool,
      options.deployToken !== undefined ? { bearerToken: options.deployToken } : {},
    ),
    () =>
      operationalStatusResponse(pool, {
        environment: options.environment,
        ...(options.network !== undefined && { network: options.network }),
        version: options.version,
      }),
    () => metricsResponse(pool),
    {
      corsAllowedOrigins: options.corsAllowedOrigins,
      rateLimitPerMinute: options.rateLimitPerMinute,
    },
    nodeSoakHandler(pool, {
      environment: options.environment,
      ...(options.network !== undefined && { network: options.network }),
      version: options.version,
      artifactDir: options.soakArtifactDir,
      ...(options.kaspadRpcUrl !== undefined && { kaspadRpcUrl: options.kaspadRpcUrl }),
    }),
  );
  const server = http.createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const boundPort =
    typeof addr === 'object' && addr !== null && 'port' in addr ? addr.port : options.port;
  log('info', 'kasgraph-api listening', {
    host: options.host,
    port: boundPort,
    graphqlEndpoint: options.graphqlEndpoint,
    graphiql: options.graphiql,
    subscriptionsEnabled: options.subscriptionsEnabled,
    deployAuthEnabled: options.deployToken !== undefined,
  });

  return {
    address: { host: options.host, port: boundPort },
    async shutdown(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (subscriptionSource !== undefined) {
        await subscriptionSource.close();
      }
      await pool.end();
    },
  };
}

export async function main(): Promise<void> {
  const options = readOptionsFromEnv();
  const running = await runKasGraphServer(options);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log('info', `received ${signal}; shutting down`);
      void running.shutdown().then(
        () => process.exit(0),
        (err: unknown) => {
          log('error', 'shutdown failed', { error: String(err) });
          process.exit(1);
        },
      );
    });
  }
}

// When run as a binary, kick off main. Skipped when imported as
// a library.
const isMainModule =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/main.js') || process.argv[1].endsWith('/main.ts'));
if (isMainModule) {
  main().catch((err: unknown) => {
    log('error', 'kasgraph-api failed to start', { error: String(err) });
    process.exit(1);
  });
}
