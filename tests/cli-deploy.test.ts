import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assembleDeployBundle,
  HttpDeployTransport,
  PgSubgraphRegistry,
  resolveDatabaseUrl,
  resolveNodeUrl,
  runDeploy,
  runRemove,
  runStatus,
  subgraphIdFromName,
  type CliIo,
  type DeployBundle,
  type FetchLike,
  type SubgraphRegistryClient,
} from '../cli/src/index.js';

// ---- helpers ---------------------------------------------------

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kasgraph-deploy-'));
}

/** Lay down a built subgraph dir: build/manifest.json + wasm + schema.graphql. */
async function writeBuiltSubgraph(
  root: string,
  opts: {
    name?: string;
    /** `null` → omit the `wasm` field from the descriptor. */
    wasm?: string | null;
    /** Set false to name a wasm in the descriptor but not create the file. */
    writeWasmFile?: boolean;
    /** `null` → omit schema.graphql. */
    schema?: string | null;
  } = {},
): Promise<void> {
  const buildDir = path.join(root, 'build');
  await mkdir(buildDir, { recursive: true });
  const wasmName = opts.wasm === undefined ? 'sg.wasm' : opts.wasm;
  await writeFile(
    path.join(buildDir, 'manifest.json'),
    JSON.stringify({ name: opts.name ?? 'kasbonds', wasm: wasmName ?? undefined, dataSources: [] }),
  );
  if (wasmName !== null && opts.writeWasmFile !== false) {
    await writeFile(path.join(buildDir, wasmName), Buffer.from([0x00, 0x61, 0x73, 0x6d]));
  }
  if (opts.schema !== null) {
    await writeFile(
      path.join(root, 'schema.graphql'),
      opts.schema ?? 'type Bond @entity { id: ID! owner: String! }',
    );
  }
}

function io(cwd: string): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: { write: (s: string) => (out.push(s), true) },
      stderr: { write: (s: string) => (err.push(s), true) },
      cwd,
    },
    out,
    err,
  };
}

class CapturingRegistry implements SubgraphRegistryClient {
  deployed: DeployBundle[] = [];
  removed: string[] = [];
  closed = 0;
  async upsertDeployment(b: DeployBundle): Promise<void> {
    this.deployed.push(b);
  }
  async setRemoved(id: string): Promise<boolean> {
    this.removed.push(id);
    return id !== 'ghost';
  }
  async fetchStatus(id: string) {
    return id === 'missing'
      ? null
      : { subgraphId: id, status: 'active', deployedAt: '2026-05-30T00:00:00Z', wasmSha256: 'abc' };
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
}

// ---- subgraphIdFromName ----------------------------------------

describe('subgraphIdFromName', () => {
  it('passes through a valid id and sanitizes a display name', () => {
    expect(subgraphIdFromName('krc20')).toBe('krc20');
    expect(subgraphIdFromName('network-stats')).toBe('network_stats');
    expect(subgraphIdFromName('My Subgraph!')).toBe('my_subgraph');
  });
  it('returns null when nothing valid survives', () => {
    expect(subgraphIdFromName('')).toBeNull();
    expect(subgraphIdFromName('---')).toBeNull();
  });
});

// ---- assembleDeployBundle --------------------------------------

describe('assembleDeployBundle', () => {
  it('assembles id + SDL + manifest + wasm sha256 from a built dir', async () => {
    const root = await scratch();
    await writeBuiltSubgraph(root, { name: 'network-stats' });
    const { bundle, error } = await assembleDeployBundle(root);
    expect(error).toBeUndefined();
    expect(bundle!.subgraphId).toBe('network_stats');
    expect(bundle!.schemaSdl).toContain('@entity');
    expect((bundle!.manifestJson as { name: string }).name).toBe('network-stats');
    // sha256 of the 4 magic bytes \0asm.
    expect(bundle!.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('errors (code 66) when the subgraph is not built', async () => {
    const root = await scratch();
    const { bundle, code } = await assembleDeployBundle(root);
    expect(bundle).toBeUndefined();
    expect(code).toBe(66);
  });

  it('errors (code 66) when the named wasm file is missing', async () => {
    const root = await scratch();
    await writeBuiltSubgraph(root, { wasm: 'sg.wasm', writeWasmFile: false });
    const { bundle, code } = await assembleDeployBundle(root);
    expect(bundle).toBeUndefined();
    expect(code).toBe(66);
  });

  it('errors when schema.graphql is missing', async () => {
    const root = await scratch();
    await writeBuiltSubgraph(root, { schema: null });
    const { error } = await assembleDeployBundle(root);
    expect(error).toMatch(/schema\.graphql/);
  });
});

// ---- PgSubgraphRegistry (mock pool) ----------------------------

describe('PgSubgraphRegistry', () => {
  class MockPool {
    calls: Array<{ sql: string; values: ReadonlyArray<unknown> | undefined }> = [];
    constructor(private readonly rows: Array<Record<string, unknown>>) {}
    async query(sql: string, values?: ReadonlyArray<unknown>) {
      this.calls.push({ sql, values });
      return { rows: this.rows };
    }
  }

  it('upsert binds (id, sdl, manifest-json-string, wasm) and is idempotent', async () => {
    const pool = new MockPool([]);
    await new PgSubgraphRegistry(pool).upsertDeployment({
      subgraphId: 'kasbonds',
      schemaSdl: 'type Bond @entity { id: ID! }',
      manifestJson: { name: 'kasbonds' },
      wasmSha256: 'deadbeef',
    });
    expect(pool.calls[0]!.sql).toMatch(/INSERT INTO kasgraph_subgraph/);
    expect(pool.calls[0]!.sql).toMatch(/ON CONFLICT \(subgraph\)/);
    expect(pool.calls[0]!.values).toEqual([
      'kasbonds',
      'type Bond @entity { id: ID! }',
      JSON.stringify({ name: 'kasbonds' }),
      'deadbeef',
    ]);
  });

  it('setRemoved reports true when a row was affected, false otherwise', async () => {
    expect(await new PgSubgraphRegistry(new MockPool([{ subgraph: 'k' }])).setRemoved('k')).toBe(
      true,
    );
    expect(await new PgSubgraphRegistry(new MockPool([])).setRemoved('k')).toBe(false);
  });

  it('fetchStatus maps a row and returns null when absent', async () => {
    const got = await new PgSubgraphRegistry(
      new MockPool([
        { subgraph: 'k', status: 'active', deployed_at: 'T', wasm_sha256: 'h' },
      ]),
    ).fetchStatus('k');
    expect(got).toEqual({ subgraphId: 'k', status: 'active', deployedAt: 'T', wasmSha256: 'h' });
    expect(await new PgSubgraphRegistry(new MockPool([])).fetchStatus('k')).toBeNull();
  });
});

// ---- runDeploy / runStatus / runRemove -------------------------

describe('runDeploy', () => {
  it('assembles + upserts the bundle and reports success', async () => {
    const root = await scratch();
    await writeBuiltSubgraph(root, { name: 'kasbonds' });
    const reg = new CapturingRegistry();
    const { io: cio, out } = io(root);
    const code = await runDeploy(['--database-url', 'postgres://x'], cio, () => reg);
    expect(code).toBe(0);
    expect(reg.deployed).toHaveLength(1);
    expect(reg.deployed[0]!.subgraphId).toBe('kasbonds');
    expect(reg.closed).toBe(1);
    expect(out.join('')).toMatch(/deployed `kasbonds`/);
  });

  it('fails with a config code when no client can be built', async () => {
    const root = await scratch();
    await writeBuiltSubgraph(root);
    const { io: cio } = io(root);
    const code = await runDeploy([], cio, () => null);
    expect(code).toBe(78);
  });

  it('propagates a build-missing error before touching the registry', async () => {
    const root = await scratch();
    const reg = new CapturingRegistry();
    const { io: cio, err } = io(root);
    const code = await runDeploy([], cio, () => reg);
    expect(code).toBe(66);
    expect(reg.deployed).toHaveLength(0);
    expect(err.join('')).toMatch(/kasgraph build/);
  });
});

describe('runStatus / runRemove', () => {
  it('status reports a deployed subgraph and errors on a missing one', async () => {
    const reg = new CapturingRegistry();
    const a = io('/x');
    expect(await runStatus(['kasbonds'], a.io, () => reg)).toBe(0);
    expect(a.out.join('')).toMatch(/kasbonds: active/);
    const b = io('/x');
    expect(await runStatus(['missing'], b.io, () => reg)).toBe(1);
  });

  it('status requires a subgraph argument', async () => {
    const { io: cio } = io('/x');
    expect(await runStatus([], cio, () => new CapturingRegistry())).toBe(64);
  });

  it('remove soft-deletes and reports, errors on an unknown subgraph', async () => {
    const reg = new CapturingRegistry();
    const a = io('/x');
    expect(await runRemove(['kasbonds'], a.io, () => reg)).toBe(0);
    expect(reg.removed).toContain('kasbonds');
    expect(a.out.join('')).toMatch(/removed `kasbonds`/);
    const b = io('/x');
    expect(await runRemove(['ghost'], b.io, () => reg)).toBe(1);
  });
});

// ---- resolveDatabaseUrl ----------------------------------------

describe('resolveDatabaseUrl', () => {
  it('prefers --database-url over the environment', () => {
    expect(resolveDatabaseUrl(['--database-url', 'postgres://flag'])).toBe('postgres://flag');
  });
});

describe('resolveNodeUrl', () => {
  it('reads --node', () => {
    expect(resolveNodeUrl(['--node', 'http://node:8080'])).toBe('http://node:8080');
    expect(resolveNodeUrl([])).toBe(process.env.KASGRAPH_NODE_URL);
  });
});

describe('HttpDeployTransport', () => {
  function mockFetch(
    impl: (url: string, init?: { method?: string; body?: string }) => { status: number; body?: unknown },
  ): { fetch: FetchLike; calls: Array<{ url: string; method?: string; body?: string }> } {
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method, body: init?.body });
      const { status, body } = impl(url, init);
      return { status, json: async () => body };
    };
    return { fetch, calls };
  }

  const bundle: DeployBundle = {
    subgraphId: 'kasbonds',
    schemaSdl: 'type Bond @entity { id: ID! }',
    manifestJson: { name: 'kasbonds' },
    wasmSha256: 'deadbeef',
  };

  it('upsertDeployment POSTs the bundle to /subgraphs', async () => {
    const { fetch, calls } = mockFetch(() => ({ status: 200, body: { subgraphId: 'kasbonds' } }));
    await new HttpDeployTransport('http://node:8080/', fetch).upsertDeployment(bundle);
    expect(calls[0]!.url).toBe('http://node:8080/subgraphs');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body!)).toEqual(bundle);
  });

  it('upsertDeployment throws with the node error message on non-2xx', async () => {
    const { fetch } = mockFetch(() => ({ status: 400, body: { error: 'bad bundle' } }));
    await expect(
      new HttpDeployTransport('http://node', fetch).upsertDeployment(bundle),
    ).rejects.toThrow(/400.*bad bundle/);
  });

  it('setRemoved DELETEs and maps 200→true, 404→false', async () => {
    const ok = mockFetch(() => ({ status: 200, body: { removed: true } }));
    expect(await new HttpDeployTransport('http://node', ok.fetch).setRemoved('kasbonds')).toBe(true);
    expect(ok.calls[0]!.url).toBe('http://node/subgraphs/kasbonds');
    expect(ok.calls[0]!.method).toBe('DELETE');

    const gone = mockFetch(() => ({ status: 404, body: { error: 'not deployed' } }));
    expect(await new HttpDeployTransport('http://node', gone.fetch).setRemoved('ghost')).toBe(false);
  });

  it('fetchStatus GETs and maps 200→status, 404→null', async () => {
    const ok = mockFetch(() => ({ status: 200, body: { subgraphId: 'kasbonds', wasmSha256: 'h' } }));
    const got = await new HttpDeployTransport('http://node', ok.fetch).fetchStatus('kasbonds');
    expect(got).toMatchObject({ subgraphId: 'kasbonds', wasmSha256: 'h' });

    const gone = mockFetch(() => ({ status: 404, body: {} }));
    expect(await new HttpDeployTransport('http://node', gone.fetch).fetchStatus('ghost')).toBeNull();
  });
});

describe('runDeploy transport selection', () => {
  it('uses the HTTP node transport when --node is given (default factory)', async () => {
    // Capture the POST the default factory's HttpDeployTransport makes by
    // stubbing global fetch.
    const root = await scratch();
    await writeBuiltSubgraph(root, { name: 'kasbonds' });
    const calls: string[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url));
      return { status: 200, json: async () => ({ subgraphId: 'kasbonds' }) };
    }) as unknown as typeof globalThis.fetch;
    try {
      const { io: cio } = io(root);
      const code = await runDeploy(['--node', 'http://node:8080'], cio);
      expect(code).toBe(0);
      expect(calls[0]).toBe('http://node:8080/subgraphs');
    } finally {
      globalThis.fetch = orig;
    }
  });
});
