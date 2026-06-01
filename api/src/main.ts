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
import { Client, Pool } from 'pg';

import { createKasGraphServer, type KasGraphServer } from './server.js';
import { handleDeployRequest, type DeployAuthOptions } from './deploy-endpoint.js';
import type { PgPoolLike } from './pg-resolvers.js';
import { PgListenSource, type PgListenClient } from './pg-listen.js';

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
  const [blocks, poi, subgraphs] = connected
    ? await Promise.all([committedBlockStats(pool), poiStats(pool), subgraphStats(pool)])
    : [
        { indexed_daa_score: null, indexed_blocks: '0' },
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
  const [blocks, poi, subgraphs] = connected
    ? await Promise.all([committedBlockStats(pool), poiStats(pool), subgraphStats(pool)])
    : [
        { indexed_daa_score: null, indexed_blocks: '0' },
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
    if (
      deployHandler !== undefined &&
      (url === '/subgraphs' || url.startsWith('/subgraphs/') || url.startsWith('/subgraphs?'))
    ) {
      deployHandler(req, res);
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
    ...(deployToken !== undefined && deployToken.length > 0 && { deployToken }),
    ...(network !== undefined && network.length > 0 && { network }),
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
