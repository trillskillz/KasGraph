// `kasgraph deploy` / `status` / `remove` — the hosted-node lifecycle commands.
//
// A built subgraph dir holds:
//   subgraph.yaml          source manifest
//   schema.graphql         entity SDL (the typed per-subgraph schema source)
//   build/manifest.json    resolved descriptor `kasgraph build` emits
//   build/<name>.wasm      the compiled mapping
//
// `deploy` assembles a deploy bundle from those (the subgraph id, its SDL, the
// resolved manifest, and the wasm's sha256) and writes a registry row into the
// store's `kasgraph_subgraph` table — the exact row the gateway/MCP read to
// serve the subgraph's typed schema (see @kasgraph/api `fetchSubgraphDeployment`
// + `executeSubgraphQuery`). `status` reads that row; `remove` soft-deletes it.
//
// The actual wasm bytes stay on disk where the node loads them (`LoadedMapping`);
// the registry carries the wasm *hash* for integrity/provenance, not the bytes.
//
// The bundle assembly is pure filesystem logic (fully unit-tested). The write
// goes through an injected `SubgraphRegistryClient` so tests use a capturing
// fake; the default client is Postgres-backed (lazy `pg`), targeting the same
// table the node/gateway use. A hosted-node HTTP transport can be added as an
// alternate client later (Phase 5) without touching the command logic.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { MANIFEST_DESCRIPTOR_FILE } from './build.js';
import type { CliIo } from './index.js';

/** What a deploy writes into the registry. */
export interface DeployBundle {
  /** SubgraphId / Postgres schema name (derived from the manifest name). */
  subgraphId: string;
  /** The subgraph's `schema.graphql`, verbatim. */
  schemaSdl: string;
  /** The resolved `build/manifest.json` descriptor. */
  manifestJson: unknown;
  /** Hex sha256 of the compiled wasm (provenance; the bytes live on disk). */
  wasmSha256: string;
}

/** A deployed subgraph's registry state, as `status` reports it. */
export interface DeployedStatus {
  subgraphId: string;
  status: string;
  deployedAt: string;
  wasmSha256: string | null;
}

/** The registry write/read surface deploy/status/remove target. */
export interface SubgraphRegistryClient {
  upsertDeployment(bundle: DeployBundle): Promise<void>;
  setRemoved(subgraphId: string): Promise<boolean>;
  fetchStatus(subgraphId: string): Promise<DeployedStatus | null>;
  /** Release any underlying resources (e.g. a pg pool). Optional. */
  close?(): Promise<void>;
}

/** Minimal pg-pool surface — structurally satisfied by `pg.Pool` and by the
 * mock pools the tests inject. Kept local so the CLI needn't depend on the
 * full `@kasgraph/api` type surface for one query shape. */
export interface DeployPool {
  query(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<{ rows: Array<Record<string, unknown>> }>;
  end?(): Promise<void>;
}

/** Factory the command uses to obtain a registry client. Tests override it. */
export type RegistryClientFactory = (
  args: string[],
  io: CliIo,
) => SubgraphRegistryClient | null;

/**
 * Derive a `SubgraphId` (Postgres schema name) from a manifest name. The id
 * must match the store's `^[a-z0-9_]+$` rule, so a display name like
 * `network-stats` becomes `network_stats`. Returns `null` if nothing valid
 * survives (e.g. an empty or all-punctuation name).
 */
export function subgraphIdFromName(name: string): string | null {
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return id.length > 0 && /^[a-z0-9_]+$/.test(id) ? id : null;
}

/**
 * Assemble a deploy bundle from a built subgraph directory. Pure filesystem
 * logic: reads `build/manifest.json` + the wasm it names + `schema.graphql`,
 * derives the subgraph id, and hashes the wasm. Returns `{ error }` (a
 * user-facing message) instead of throwing, so the command can map it to an
 * exit code.
 */
export async function assembleDeployBundle(
  root: string,
): Promise<{ bundle?: DeployBundle; error?: string; code?: number }> {
  const descriptorPath = path.join(root, 'build', MANIFEST_DESCRIPTOR_FILE);
  if (!existsSync(descriptorPath)) {
    return {
      error: `${descriptorPath} not found — run \`kasgraph build\` first`,
      code: 66, // EX_NOINPUT
    };
  }

  let descriptor: { name?: string; wasm?: string };
  try {
    descriptor = JSON.parse(await readFile(descriptorPath, 'utf8')) as typeof descriptor;
  } catch (err) {
    return { error: `failed to parse ${descriptorPath}: ${errText(err)}`, code: 65 };
  }

  const name = typeof descriptor.name === 'string' ? descriptor.name : '';
  const subgraphId = subgraphIdFromName(name);
  if (subgraphId === null) {
    return {
      error: `manifest name ${JSON.stringify(name)} has no valid subgraph id (need [a-z0-9_])`,
      code: 65,
    };
  }

  const wasmName = typeof descriptor.wasm === 'string' ? descriptor.wasm : '';
  if (wasmName.length === 0) {
    return { error: `${descriptorPath} has no \`wasm\` field`, code: 65 };
  }
  const wasmPath = path.join(root, 'build', wasmName);
  if (!existsSync(wasmPath)) {
    return { error: `${wasmPath} not found — run \`kasgraph build\` first`, code: 66 };
  }
  const wasmBytes = await readFile(wasmPath);
  const wasmSha256 = createHash('sha256').update(wasmBytes).digest('hex');

  const schemaPath = path.join(root, 'schema.graphql');
  if (!existsSync(schemaPath)) {
    return { error: `${schemaPath} not found`, code: 66 };
  }
  const schemaSdl = await readFile(schemaPath, 'utf8');

  return {
    bundle: { subgraphId, schemaSdl, manifestJson: descriptor, wasmSha256 },
  };
}

/** Postgres-backed registry client. Writes the same `kasgraph_subgraph` row
 * the node's `Store::upsert_subgraph_deployment` writes and the gateway reads. */
export class PgSubgraphRegistry implements SubgraphRegistryClient {
  constructor(private readonly pool: DeployPool) {}

  async upsertDeployment(bundle: DeployBundle): Promise<void> {
    await this.pool.query(
      `INSERT INTO kasgraph_subgraph (subgraph, schema_sdl, manifest_json, wasm_sha256)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subgraph) DO UPDATE SET
         schema_sdl = EXCLUDED.schema_sdl,
         manifest_json = EXCLUDED.manifest_json,
         wasm_sha256 = EXCLUDED.wasm_sha256,
         status = 'active',
         deployed_at = NOW()`,
      [
        bundle.subgraphId,
        bundle.schemaSdl,
        JSON.stringify(bundle.manifestJson),
        bundle.wasmSha256,
      ],
    );
  }

  async setRemoved(subgraphId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kasgraph_subgraph SET status = 'removed'
       WHERE subgraph = $1 AND status <> 'removed'
       RETURNING subgraph`,
      [subgraphId],
    );
    return result.rows.length > 0;
  }

  async fetchStatus(subgraphId: string): Promise<DeployedStatus | null> {
    const result = await this.pool.query(
      `SELECT subgraph, status, deployed_at, wasm_sha256
       FROM kasgraph_subgraph WHERE subgraph = $1`,
      [subgraphId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      subgraphId: String(row['subgraph']),
      status: String(row['status']),
      deployedAt: String(row['deployed_at']),
      wasmSha256: row['wasm_sha256'] == null ? null : String(row['wasm_sha256']),
    };
  }

  async close(): Promise<void> {
    await this.pool.end?.();
  }
}

/** Resolve the database URL from `--database-url <url>` or `DATABASE_URL`. */
export function resolveDatabaseUrl(args: string[]): string | undefined {
  const i = args.indexOf('--database-url');
  if (i >= 0 && typeof args[i + 1] === 'string') return args[i + 1];
  return process.env.DATABASE_URL;
}

/** Default factory: a Postgres-backed client from `--database-url`/`DATABASE_URL`.
 * Lazily imports `pg` so a missing driver is a clear error, not a load crash. */
const defaultClientFactory: RegistryClientFactory = (args, io) => {
  const url = resolveDatabaseUrl(args);
  if (url === undefined || url.length === 0) {
    io.stderr.write(
      'kasgraph: no database URL — pass `--database-url <url>` or set DATABASE_URL\n',
    );
    return null;
  }
  // Constructed lazily inside an async IIFE-free path: the bin awaits the
  // command, and `pg` is resolved on first query. We wrap the dynamic import
  // in a thin pool proxy so this stays synchronous for the factory contract.
  const lazyPool: DeployPool = {
    async query(text, values) {
      const pg = (await import('pg')) as unknown as { default: { Pool: new (c: { connectionString: string }) => DeployPool } };
      const pool = new pg.default.Pool({ connectionString: url });
      try {
        return await pool.query(text, values);
      } finally {
        await pool.end?.();
      }
    },
  };
  return new PgSubgraphRegistry(lazyPool);
};

function nonFlagArg(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('--'));
}

/** `kasgraph deploy [--database-url <url>]` — package the built subgraph and
 * write its registry row. */
export async function runDeploy(
  args: string[],
  io: CliIo,
  makeClient: RegistryClientFactory = defaultClientFactory,
): Promise<number> {
  const { bundle, error, code } = await assembleDeployBundle(io.cwd);
  if (bundle === undefined) {
    io.stderr.write(`kasgraph deploy: ${error}\n`);
    return code ?? 65;
  }

  const client = makeClient(args, io);
  if (client === null) return 78; // EX_CONFIG

  try {
    await client.upsertDeployment(bundle);
  } catch (err) {
    io.stderr.write(`kasgraph deploy: registry write failed: ${errText(err)}\n`);
    return 70; // EX_SOFTWARE
  } finally {
    await client.close?.();
  }

  io.stdout.write(
    `deployed \`${bundle.subgraphId}\` (wasm sha256 ${bundle.wasmSha256.slice(0, 12)}…)\n`,
  );
  return 0;
}

/** `kasgraph status <subgraph>` — report a deployed subgraph's registry state. */
export async function runStatus(
  args: string[],
  io: CliIo,
  makeClient: RegistryClientFactory = defaultClientFactory,
): Promise<number> {
  const subgraphId = nonFlagArg(args);
  if (subgraphId === undefined) {
    io.stderr.write('kasgraph status: usage: kasgraph status <subgraph>\n');
    return 64; // EX_USAGE
  }
  const client = makeClient(args, io);
  if (client === null) return 78;

  try {
    const status = await client.fetchStatus(subgraphId);
    if (status === null) {
      io.stderr.write(`kasgraph status: \`${subgraphId}\` is not deployed\n`);
      return 1;
    }
    io.stdout.write(
      `${status.subgraphId}: ${status.status} (deployed ${status.deployedAt})\n`,
    );
    return 0;
  } catch (err) {
    io.stderr.write(`kasgraph status: registry read failed: ${errText(err)}\n`);
    return 70;
  } finally {
    await client.close?.();
  }
}

/** `kasgraph remove <subgraph>` — soft-delete a deployed subgraph (keeps its
 * data schema + history for audit; the gateway stops serving it). */
export async function runRemove(
  args: string[],
  io: CliIo,
  makeClient: RegistryClientFactory = defaultClientFactory,
): Promise<number> {
  const subgraphId = nonFlagArg(args);
  if (subgraphId === undefined) {
    io.stderr.write('kasgraph remove: usage: kasgraph remove <subgraph>\n');
    return 64;
  }
  const client = makeClient(args, io);
  if (client === null) return 78;

  try {
    const removed = await client.setRemoved(subgraphId);
    if (!removed) {
      io.stderr.write(`kasgraph remove: \`${subgraphId}\` is not deployed\n`);
      return 1;
    }
    io.stdout.write(`removed \`${subgraphId}\`\n`);
    return 0;
  } catch (err) {
    io.stderr.write(`kasgraph remove: registry write failed: ${errText(err)}\n`);
    return 70;
  } finally {
    await client.close?.();
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
