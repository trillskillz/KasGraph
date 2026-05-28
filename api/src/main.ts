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
import { Pool } from 'pg';

import { createKasGraphServer, type KasGraphServer } from './server.js';
import type { PgPoolLike } from './pg-resolvers.js';

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
 * Build a Node-http handler that routes `GET /healthz` to the
 * supplied `healthCheck` and forwards everything else to the
 * Yoga handler. Yoga itself is a Fetch-API function, so we use
 * its built-in Node adapter (`yoga.handle`) when present, or
 * fall back to its `.requestListener` shape.
 */
export function createKasGraphHttpHandler(
  yoga: KasGraphServer,
  healthCheck: HealthCheck,
): NodeHttpHandler {
  return (req, res) => {
    const url = req.url ?? '/';
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
  return {
    databaseUrl,
    host: process.env.HOST ?? '0.0.0.0',
    port: envInt('PORT', 4000),
    graphqlEndpoint: process.env.GRAPHQL_ENDPOINT ?? '/graphql',
    graphiql: envBoolean('GRAPHIQL', true),
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
  const yoga = createKasGraphServer({
    pool,
    graphqlEndpoint: options.graphqlEndpoint,
    graphiql: options.graphiql,
  });
  const handler = createKasGraphHttpHandler(yoga, () => healthzResponse(pool));
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
  });

  return {
    address: { host: options.host, port: boundPort },
    async shutdown(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
