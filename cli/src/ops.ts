import type { CliIo } from './index.js';
import { resolveDatabaseUrl, resolveNodeUrl } from './deploy.js';

type JsonObject = Record<string, unknown>;

type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; text(): Promise<string>; json(): Promise<unknown> }>;

interface OpsPool {
  query(text: string, values?: ReadonlyArray<unknown>): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
}

type OpsPoolFactory = (databaseUrl: string) => OpsPool;

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function jsonOut(io: CliIo, value: JsonObject): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function textOut(io: CliIo, rows: Array<[string, unknown]>): void {
  for (const [label, value] of rows) {
    io.stdout.write(`${label}: ${value ?? 'unavailable'}\n`);
  }
}

function nodeBase(args: string[]): string | undefined {
  return resolveNodeUrl(args) ?? process.env.KASGRAPH_API_URL;
}

async function fetchJson(url: string, fetchImpl: FetchLike): Promise<{ ok: boolean; body: unknown; status: number }> {
  const res = await fetchImpl(url, { method: 'GET' });
  try {
    return { ok: res.status >= 200 && res.status < 300, status: res.status, body: await res.json() };
  } catch {
    return { ok: false, status: res.status, body: await res.text() };
  }
}

export async function runHealth(
  args: string[],
  io: CliIo,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<number> {
  const base = nodeBase(args);
  if (base === undefined || base.length === 0) {
    io.stderr.write('kasgraph health: pass --node <url> or set KASGRAPH_API_URL / KASGRAPH_NODE_URL\n');
    return 64;
  }
  const { ok, body, status } = await fetchJson(`${base.replace(/\/+$/, '')}/status`, fetchImpl);
  if (!ok || typeof body !== 'object' || body === null) {
    io.stderr.write(`kasgraph health: node status failed with HTTP ${status}\n`);
    return 70;
  }
  const b = body as JsonObject;
  if (hasFlag(args, '--json')) {
    jsonOut(io, b);
  } else {
    textOut(io, [
      ['API URL', base],
      ['API health', b.status],
      ['Environment', b.environment],
      ['Network', b.network],
      ['RPC', b.rpcConnected],
      ['Postgres', b.postgresConnected],
      ['Version', b.version],
    ]);
  }
  return 0;
}

export async function runIndexStatus(
  args: string[],
  io: CliIo,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<number> {
  const base = nodeBase(args);
  if (base === undefined || base.length === 0) {
    io.stderr.write('kasgraph index status: pass --node <url> or set KASGRAPH_API_URL / KASGRAPH_NODE_URL\n');
    return 64;
  }
  const { ok, body, status } = await fetchJson(`${base.replace(/\/+$/, '')}/status`, fetchImpl);
  if (!ok || typeof body !== 'object' || body === null) {
    io.stderr.write(`kasgraph index status: node status failed with HTTP ${status}\n`);
    return 70;
  }
  const b = body as JsonObject;
  if (hasFlag(args, '--json')) {
    jsonOut(io, b);
  } else {
    textOut(io, [
      ['Network', b.network],
      ['Indexed DAA score', b.indexedDaaScore],
      ['Indexed blocks', b.indexedBlocks],
      ['Latest POI checkpoint', b.latestPoiCheckpoint],
      ['Subgraphs deployed', b.subgraphsDeployed],
      ['Version', b.version],
    ]);
  }
  return 0;
}

export async function runIndexInspect(args: string[], io: CliIo): Promise<number> {
  io.stderr.write(
    'kasgraph index inspect: pending backend support for detailed index inspection; use `kasgraph index status --node <url>` for public status\n',
  );
  return hasFlag(args, '--json') ? 78 : 64;
}

export async function runPoiLatest(
  args: string[],
  io: CliIo,
  makePool: OpsPoolFactory = defaultPool,
): Promise<number> {
  const databaseUrl = resolveDatabaseUrl(args);
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    io.stderr.write('kasgraph poi latest: pass --database-url <url> or set DATABASE_URL\n');
    return 64;
  }
  const pool = makePool(databaseUrl);
  try {
    const result = await pool.query(
      `SELECT subgraph, block_daa_score::text AS daa_score, '0x' || encode(poi_hash, 'hex') AS checkpoint_hash
       FROM kasgraph_poi
       ORDER BY block_daa_score DESC
       LIMIT 1`,
    );
    const row = result.rows[0];
    if (row === undefined) {
      io.stderr.write('kasgraph poi latest: no POI checkpoints found\n');
      return 1;
    }
    if (hasFlag(args, '--json')) {
      jsonOut(io, {
        subgraph: row.subgraph,
        daaScore: row.daa_score,
        checkpointHash: row.checkpoint_hash,
      });
    } else {
      textOut(io, [
        ['Subgraph', row.subgraph],
        ['DAA score', row.daa_score],
        ['Checkpoint hash', row.checkpoint_hash],
      ]);
    }
    return 0;
  } finally {
    await pool.end?.();
  }
}

export async function runPoiPending(kind: 'verify' | 'compare', args: string[], io: CliIo): Promise<number> {
  io.stderr.write(
    `kasgraph poi ${kind}: pending checkpoint-range backend support; no verification result was produced\n`,
  );
  return hasFlag(args, '--json') ? 78 : 64;
}

export async function runDbStats(
  args: string[],
  io: CliIo,
  makePool: OpsPoolFactory = defaultPool,
): Promise<number> {
  const databaseUrl = resolveDatabaseUrl(args);
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    io.stderr.write('kasgraph db stats: pass --database-url <url> or set DATABASE_URL\n');
    return 64;
  }
  const pool = makePool(databaseUrl);
  try {
    const result = await pool.query(
      `SELECT json_build_object(
        'committedBlocks', (SELECT COUNT(*) FROM kasgraph_committed_block),
        'indexedDaaScore', (SELECT MAX(daa_score)::text FROM kasgraph_committed_block),
        'poiCheckpoints', (SELECT COUNT(*) FROM kasgraph_poi),
        'subgraphs', (SELECT COUNT(*) FROM kasgraph_subgraph WHERE status <> 'removed')
      ) AS stats`,
    );
    const stats = (result.rows[0]?.stats ?? {}) as JsonObject;
    if (hasFlag(args, '--json')) {
      jsonOut(io, stats);
    } else {
      textOut(io, Object.entries(stats));
    }
    return 0;
  } finally {
    await pool.end?.();
  }
}

export async function runRpcStatus(
  args: string[],
  io: CliIo,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<number> {
  const base = nodeBase(args);
  if (base === undefined || base.length === 0) {
    io.stderr.write('kasgraph rpc status: pass --node <url> or set KASGRAPH_API_URL / KASGRAPH_NODE_URL\n');
    return 64;
  }
  const { ok, body, status } = await fetchJson(`${base.replace(/\/+$/, '')}/status`, fetchImpl);
  if (!ok || typeof body !== 'object' || body === null) {
    io.stderr.write(`kasgraph rpc status: node status failed with HTTP ${status}\n`);
    return 70;
  }
  const b = body as JsonObject;
  if (hasFlag(args, '--json')) {
    jsonOut(io, { rpcConnected: b.rpcConnected, network: b.network });
  } else {
    textOut(io, [
      ['RPC connected', b.rpcConnected],
      ['Network', b.network],
    ]);
  }
  return 0;
}

export async function runLogsTail(args: string[], io: CliIo): Promise<number> {
  io.stderr.write(
    'kasgraph logs tail: pending protected hosted log source; no public log stream is exposed\n',
  );
  return hasFlag(args, '--json') ? 78 : 64;
}

function defaultPool(databaseUrl: string): OpsPool {
  return {
    async query(text, values) {
      const pg = (await import('pg')) as unknown as { default: { Pool: new (c: { connectionString: string }) => OpsPool } };
      const pool = new pg.default.Pool({ connectionString: databaseUrl });
      try {
        return await pool.query(text, values);
      } finally {
        await pool.end?.();
      }
    },
  };
}
