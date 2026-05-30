// End-to-end: deploy a subgraph into the registry, then query it typed —
// against a REAL Postgres, exercising the actual PgSubgraphRegistry (the CLI's
// deploy write) and PgMcpHandlers (the gateway/MCP read) code paths rather than
// mock pools. Proves the build→deploy→query loop composes:
//
//   deploy  → PgSubgraphRegistry.upsertDeployment  → kasgraph_subgraph row
//   query   → PgMcpHandlers.execute_query → fetchSubgraphDeployment (reads the
//             deployed SDL) → executeSubgraphQuery (typed query over
//             "<id>".entity_versions)
//   remove  → PgSubgraphRegistry.setRemoved → the gateway stops serving it
//
// Gated on DATABASE_URL (like the Rust `integration-pg` feature): without it
// the suite is skipped, so the default `npx vitest run` / CI stays green. Run:
//   DATABASE_URL=postgres://kasgraph:kasgraph@127.0.0.1:5434/kasgraph npx vitest run e2e-deploy-query

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PgMcpHandlers } from '../mcp/src/index.js';
import { PgSubgraphRegistry, type DeployBundle } from '../cli/src/index.js';

const DATABASE_URL = process.env.DATABASE_URL;
const suite = DATABASE_URL !== undefined && DATABASE_URL.length > 0 ? describe : describe.skip;

// A unique id per run so concurrent/leftover runs never collide.
const SG = `e2e_${Math.random().toString(36).slice(2, 10)}`;
const SDL = 'type Bond @entity { id: ID! owner: String! }';

suite('e2e: deploy → typed query → remove (real Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    // The global registry table (idempotent — matches the migration DDL).
    await pool.query(
      `CREATE TABLE IF NOT EXISTS kasgraph_subgraph (
         subgraph TEXT PRIMARY KEY,
         schema_sdl TEXT NOT NULL,
         manifest_json JSONB NOT NULL,
         wasm_sha256 TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         deployed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`,
    );
    // Committed-block history table (list_subgraphs LEFT JOINs it for the
    // indexed-block count; empty here → 0).
    await pool.query(
      `CREATE TABLE IF NOT EXISTS kasgraph_committed_block (
         subgraph TEXT NOT NULL,
         block_hash TEXT NOT NULL,
         daa_score BIGINT NOT NULL,
         served_by TEXT NOT NULL,
         committed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (subgraph, block_hash)
       )`,
    );
    // The subgraph's own data schema + entity table (what ensure_subgraph_schema
    // creates) + one entity version to query back.
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${SG}"`);
    await pool.query(
      `CREATE TABLE IF NOT EXISTS "${SG}".entity_versions (
         entity_type TEXT NOT NULL,
         entity_id TEXT NOT NULL,
         block_daa_score BIGINT NOT NULL,
         payload JSONB NOT NULL,
         PRIMARY KEY (entity_type, entity_id, block_daa_score)
       )`,
    );
    await pool.query(
      `INSERT INTO "${SG}".entity_versions (entity_type, entity_id, block_daa_score, payload)
       VALUES ('Bond', 'b1', 100, $1)`,
      [JSON.stringify({ id: 'b1', owner: 'alice' })],
    );
  });

  afterAll(async () => {
    if (pool === undefined) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${SG}" CASCADE`);
    await pool.query('DELETE FROM kasgraph_subgraph WHERE subgraph = $1', [SG]);
    await pool.end();
  });

  it('deploys, serves the typed schema + a typed query, then stops on remove', async () => {
    const registry = new PgSubgraphRegistry(pool);
    const handlers = new PgMcpHandlers(pool);

    const bundle: DeployBundle = {
      subgraphId: SG,
      schemaSdl: SDL,
      manifestJson: { name: SG, dataSources: [] },
      wasmSha256: 'a'.repeat(64),
    };

    // Not deployed yet → get_schema falls back to the base meta schema.
    const before = await handlers.get_schema({ subgraph_id: SG });
    expect(before.schema_sdl).toContain('type CommittedBlock');

    // Deploy → the registry row is written.
    await registry.upsertDeployment(bundle);

    // list_subgraphs (registry-sourced) now includes it, before any blocks.
    const listed = await handlers.list_subgraphs({ keyword: SG });
    expect(listed.map((s) => s.id)).toContain(SG);
    expect(listed.find((s) => s.id === SG)!.blocks_indexed).toBe(0);

    // get_schema now returns the subgraph's OWN typed schema.
    const after = await handlers.get_schema({ subgraph_id: SG });
    expect(after.schema_sdl).toContain('bond(id: ID!): Bond');
    expect(after.schema_sdl).not.toContain('type CommittedBlock');

    // A typed query routes to "<id>".entity_versions and returns the entity.
    const res = await handlers.execute_query({
      subgraph_id: SG,
      query: '{ bond(id: "b1") { id owner } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ bond: { id: 'b1', owner: 'alice' } });

    // Remove → the gateway stops serving the typed schema; the same query now
    // falls back to the base meta gateway, which has no `bond` field → errors.
    expect(await registry.setRemoved(SG)).toBe(true);
    const afterRemove = await handlers.execute_query({
      subgraph_id: SG,
      query: '{ bond(id: "b1") { id owner } }',
    });
    expect(afterRemove.errors).toBeDefined();
    expect(afterRemove.errors!.length).toBeGreaterThan(0);

    // …and list_subgraphs no longer reports the removed subgraph.
    const listedAfter = await handlers.list_subgraphs({ keyword: SG });
    expect(listedAfter.map((s) => s.id)).not.toContain(SG);
  });
});
