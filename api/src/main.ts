// kasgraph-api — operator entry binary.
//
// Reads env config, constructs a pg.Pool, wires it into
// `createKasGraphServer`, and exposes the resulting Yoga handler
// via Node's built-in `http` module. Adds a `/healthz` endpoint
// that runs a cheap `SELECT 1` against the pool so load
// balancers and orchestrators can detect database outages.
//
// Splits cleanly so the routing + healthz logic is unit-testable
// without binding sockets:
//
//   - healthzResponse(pool)               → {status, body, contentType}
//   - createKasGraphHttpHandler(yoga, hc) → (req, res) => void
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

// ---------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------

export type NodeHttpHandler = (req: IncomingMessage, res: ServerResponse) => void;
export type HealthCheck = () => Promise<HealthzResponse>;

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
): NodeHttpHandler {
  return (req, res) => {
    const url = req.url ?? '/';
    if (
      deployHandler !== undefined &&
      (url === '/subgraphs' || url.startsWith('/subgraphs/') || url.startsWith('/subgraphs?'))
    ) {
      deployHandler(req, res);
      return;
    }
    if (url === '/healthz' || url.startsWith('/healthz?')) {
      // Always allow GET + HEAD on healthz; anything else is
      // 405 so operators don't accidentally POST to the wrong
      // path and get confusing GraphQL errors back.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' });
        res.end();
        return;
      }
      healthCheck()
        .then(({ status, body, contentType }) => {
          res.writeHead(status, { 'content-type': contentType });
          if (req.method === 'HEAD') {
            res.end();
          } else {
            res.end(body);
          }
        })
        .catch((err: unknown) => {
          // healthzResponse already swallows errors; this is for
          // bugs in the wrapper itself.
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(String(err));
        });
      return;
    }

    // Yoga's server instance is callable as a Node http request
    // listener directly.
    (yoga as unknown as NodeHttpHandler)(req, res);
  };
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
  return {
    databaseUrl,
    host: process.env.HOST ?? '0.0.0.0',
    port: envInt('PORT', 4000),
    graphqlEndpoint: process.env.GRAPHQL_ENDPOINT ?? '/graphql',
    graphiql: envBoolean('GRAPHIQL', true),
    subscriptionsEnabled: envBoolean('KASGRAPH_SUBSCRIPTIONS_ENABLED', true),
    listenDatabaseUrl,
    ...(deployToken !== undefined && deployToken.length > 0 && { deployToken }),
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
