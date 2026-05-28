// kasgraph-mcp — operator entry binary.
//
// Reads `DATABASE_URL` from env, constructs a `pg.Pool`, builds
// `PgMcpHandlers`, and exposes the MCP tool surface over stdio
// for LLM clients. Mirrors the `kasgraph-api` entry binary so
// operators get a consistent shape between the two services.

import { Pool } from 'pg';

import { PgMcpHandlers } from './pg-handlers.js';
import { runMcpStdioServer } from './server.js';

function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  extra?: Record<string, unknown>,
): void {
  // MCP stdio uses stdout for protocol frames — always emit
  // logs to stderr so they never collide with the transport.
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...extra,
  });
  process.stderr.write(line + '\n');
}

export interface RunMcpOptions {
  databaseUrl: string;
}

export function readOptionsFromEnv(): RunMcpOptions {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.KASGRAPH_DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      'DATABASE_URL (or KASGRAPH_DATABASE_URL) must be set so the MCP server can connect to Postgres',
    );
  }
  return { databaseUrl };
}

export interface RunningMcpServer {
  shutdown(): Promise<void>;
}

/**
 * Boot the MCP stdio server with a fresh `pg.Pool`. Returns a
 * handle that cleanly closes the transport, the server, and the
 * pool. Resolves once the transport is connected — the server
 * itself stays running until the caller `shutdown()`s it (or
 * the stdio stream closes from the client side).
 */
export async function runKasGraphMcpServer(
  options: RunMcpOptions,
): Promise<RunningMcpServer> {
  const pool = new Pool({ connectionString: options.databaseUrl });
  const handlers = new PgMcpHandlers(pool);
  const { server, transport } = await runMcpStdioServer(handlers);
  log('info', 'kasgraph-mcp connected over stdio');

  return {
    async shutdown(): Promise<void> {
      try {
        await server.close();
      } catch (err) {
        log('warn', 'server.close failed', { error: String(err) });
      }
      try {
        await transport.close();
      } catch (err) {
        log('warn', 'transport.close failed', { error: String(err) });
      }
      await pool.end();
    },
  };
}

export async function main(): Promise<void> {
  const options = readOptionsFromEnv();
  const running = await runKasGraphMcpServer(options);

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

const isMainModule =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('/main.js') || process.argv[1].endsWith('/main.ts'));
if (isMainModule) {
  main().catch((err: unknown) => {
    log('error', 'kasgraph-mcp failed to start', { error: String(err) });
    process.exit(1);
  });
}
