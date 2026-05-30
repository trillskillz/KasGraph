import { describe, expect, it } from 'vitest';

import {
  handleDeployRequest,
  parseDeployBundle,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

class MockPool implements PgPoolLike {
  readonly calls: Array<{ sql: string; values: ReadonlyArray<unknown> | undefined }> = [];
  private readonly responses: Array<QueryResultRow[]>;
  constructor(responses: Array<QueryResultRow[]> = []) {
    this.responses = [...responses];
  }
  async query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>> {
    this.calls.push({ sql: text, values });
    return { rows: (this.responses.shift() ?? []) as TRow[] };
  }
}

const BUNDLE = {
  subgraphId: 'kasbonds',
  schemaSdl: 'type Bond @entity { id: ID! }',
  manifestJson: { name: 'kasbonds' },
  wasmSha256: 'deadbeef',
};

describe('parseDeployBundle', () => {
  it('accepts a well-formed bundle', () => {
    expect(parseDeployBundle(BUNDLE).input).toEqual(BUNDLE);
  });
  it('rejects a bad id, missing sdl/manifest, and non-string wasm', () => {
    expect(parseDeployBundle({ ...BUNDLE, subgraphId: 'Bad-Id' }).error).toMatch(/subgraphId/);
    expect(parseDeployBundle({ ...BUNDLE, schemaSdl: '' }).error).toMatch(/schemaSdl/);
    expect(parseDeployBundle({ ...BUNDLE, manifestJson: undefined }).error).toMatch(/manifestJson/);
    expect(parseDeployBundle({ ...BUNDLE, wasmSha256: 7 }).error).toMatch(/wasmSha256/);
    expect(parseDeployBundle('nope').error).toMatch(/JSON object/);
  });

  it('carries wasmBase64 and integrity-checks it against wasmSha256', () => {
    // No declared hash → bytes accepted as-is.
    const noHash = { subgraphId: 'k', schemaSdl: 's', manifestJson: {}, wasmBase64: 'AGFzbQ==' };
    expect(parseDeployBundle(noHash).input?.wasmBase64).toBe('AGFzbQ==');
    // Declared hash that doesn't match the bytes → rejected.
    const bad = { ...noHash, wasmSha256: 'deadbeef' };
    expect(parseDeployBundle(bad).error).toMatch(/sha256 mismatch/);
  });
});

describe('handleDeployRequest', () => {
  it('POST /subgraphs upserts a valid bundle and returns the id', async () => {
    const pool = new MockPool();
    const res = await handleDeployRequest({ method: 'POST', path: '/subgraphs', body: BUNDLE }, pool);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subgraphId: 'kasbonds', status: 'active' });
    expect(pool.calls[0]!.sql).toMatch(/INSERT INTO kasgraph_subgraph/);
    // No wasmBase64 in this bundle → wasm_bytes binds null.
    expect(pool.calls[0]!.values).toEqual([
      'kasbonds',
      BUNDLE.schemaSdl,
      JSON.stringify(BUNDLE.manifestJson),
      'deadbeef',
      null,
    ]);
  });

  it('POST persists wasm bytes (base64 → BYTEA Buffer) when present', async () => {
    const pool = new MockPool();
    const res = await handleDeployRequest(
      { method: 'POST', path: '/subgraphs', body: { ...BUNDLE, wasmBase64: 'AGFzbQ==', wasmSha256: undefined } },
      pool,
    );
    expect(res.status).toBe(200);
    expect(pool.calls[0]!.sql).toMatch(/wasm_bytes/);
    const bytes = pool.calls[0]!.values![4];
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect((bytes as Buffer).equals(Buffer.from('AGFzbQ==', 'base64'))).toBe(true);
  });

  it('POST with an invalid bundle is a 400 and never queries', async () => {
    const pool = new MockPool();
    const res = await handleDeployRequest(
      { method: 'POST', path: '/subgraphs', body: { subgraphId: 'kasbonds' } },
      pool,
    );
    expect(res.status).toBe(400);
    expect(pool.calls).toHaveLength(0);
  });

  it('GET /subgraphs/:id returns 200 when deployed, 404 otherwise', async () => {
    const found = new MockPool([
      [{ schema_sdl: 's', manifest_json: {}, wasm_sha256: 'h' }],
    ]);
    const okRes = await handleDeployRequest({ method: 'GET', path: '/subgraphs/kasbonds' }, found);
    expect(okRes.status).toBe(200);
    expect(okRes.body).toMatchObject({ subgraphId: 'kasbonds', deployed: true, wasmSha256: 'h' });

    const missing = new MockPool([[]]);
    const missRes = await handleDeployRequest({ method: 'GET', path: '/subgraphs/ghost' }, missing);
    expect(missRes.status).toBe(404);
  });

  it('DELETE /subgraphs/:id soft-removes (200) or reports 404', async () => {
    const removed = new MockPool([[{ subgraph: 'kasbonds' }]]);
    const okRes = await handleDeployRequest(
      { method: 'DELETE', path: '/subgraphs/kasbonds' },
      removed,
    );
    expect(okRes.status).toBe(200);
    expect(okRes.body).toEqual({ subgraphId: 'kasbonds', removed: true });

    const none = new MockPool([[]]);
    const missRes = await handleDeployRequest({ method: 'DELETE', path: '/subgraphs/ghost' }, none);
    expect(missRes.status).toBe(404);
  });

  it('404s an unknown path and 400s a bad id', async () => {
    const pool = new MockPool();
    expect((await handleDeployRequest({ method: 'GET', path: '/nope' }, pool)).status).toBe(404);
    expect(
      (await handleDeployRequest({ method: 'GET', path: '/subgraphs/Bad-Id' }, pool)).status,
    ).toBe(400);
  });
});
