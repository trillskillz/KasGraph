import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createKasGraphHttpHandler,
  createKasGraphServer,
  healthzResponse,
  metricsResponse,
  nodeDeployHandler,
  nodeSoakHandler,
  operationalStatusResponse,
  readOptionsFromEnv,
  soakStatusResponse,
  type HealthCheck,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

class StubPool implements PgPoolLike {
  constructor(private readonly throws?: Error) {}

  async query<TRow extends QueryResultRow = QueryResultRow>(
    _text: string,
    _values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>> {
    if (this.throws !== undefined) {
      throw this.throws;
    }
    return { rows: [] as TRow[] };
  }
}

class OperationalStubPool implements PgPoolLike {
  async query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    _values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>> {
    if (text.includes('MAX(daa_score)')) {
      return {
        rows: [
          {
            indexed_daa_score: '467579632',
            indexed_blocks: '1204',
          },
        ] as TRow[],
      };
    }
    if (text.includes('latest_poi_checkpoint')) {
      return {
        rows: [
          {
            latest_poi_checkpoint: Buffer.from('8fa4b210', 'hex'),
            poi_checkpoints_total: '7',
          },
        ] as TRow[],
      };
    }
    if (text.includes('subgraphs_deployed')) {
      return { rows: [{ subgraphs_deployed: '2' }] as TRow[] };
    }
    return { rows: [] as TRow[] };
  }
}

describe('healthzResponse', () => {
  it('returns 200 ok when the pool accepts SELECT 1', async () => {
    const res = await healthzResponse(new StubPool());
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('application/json');
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('returns 503 with the error message when the pool throws', async () => {
    const res = await healthzResponse(
      new StubPool(new Error('connection refused on 5432')),
    );
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body) as { status: string; error: string };
    expect(body.status).toBe('unhealthy');
    expect(body.error).toContain('connection refused on 5432');
  });
});

describe('operational status and metrics responses', () => {
  it('returns real DB-derived status fields and unavailable RPC state', async () => {
    const res = await operationalStatusResponse(new OperationalStubPool(), {
      environment: 'testnet',
      network: 'kaspa-testnet-10',
      version: '0.1.0',
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as {
      status: string;
      environment: string;
      network: string;
      indexedDaaScore: string;
      indexedBlocks: number;
      rpcConnected: string;
      postgresConnected: boolean;
      latestPoiCheckpoint: string;
      poiCheckpointsTotal: number;
      subgraphsDeployed: number;
    };
    expect(body.status).toBe('ok');
    expect(body.environment).toBe('testnet');
    expect(body.network).toBe('kaspa-testnet-10');
    expect(body.indexedDaaScore).toBe('467579632');
    expect(body.indexedBlocks).toBe(1204);
    expect(body.rpcConnected).toBe('unavailable');
    expect(body.postgresConnected).toBe(true);
    expect(body.latestPoiCheckpoint).toBe('0x8fa4b210');
    expect(body.poiCheckpointsTotal).toBe(7);
    expect(body.subgraphsDeployed).toBe(2);
  });

  it('keeps unavailable DB-backed values neutral when Postgres is down', async () => {
    const res = await operationalStatusResponse(new StubPool(new Error('db down')), {
      environment: 'local',
      version: '0.1.0',
    });
    expect(res.status).toBe(503);
    const body = JSON.parse(res.body) as {
      status: string;
      indexedDaaScore: string | null;
      indexedBlocks: number;
      postgresConnected: boolean;
      latestPoiCheckpoint: string | null;
    };
    expect(body.status).toBe('degraded');
    expect(body.indexedDaaScore).toBeNull();
    expect(body.indexedBlocks).toBe(0);
    expect(body.postgresConnected).toBe(false);
    expect(body.latestPoiCheckpoint).toBeNull();
  });

  it('emits scrapeable process and database metrics', async () => {
    const res = await metricsResponse(new OperationalStubPool());
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/plain');
    expect(res.body).toContain('kasgraph_postgres_connected 1');
    expect(res.body).toContain('kasgraph_indexed_blocks_total 1204');
    expect(res.body).toContain('kasgraph_indexed_daa_score 467579632');
    expect(res.body).toContain('kasgraph_poi_checkpoints_total 7');
    expect(res.body).toContain('kasgraph_subgraphs_deployed 2');
  });

  it('marks a non-failed live soak complete after the 24-hour target', async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), 'kasgraph-soak-'));
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-02T16:00:00Z'));
    try {
      await writeFile(
        path.join(artifactDir, 'summary.json'),
        JSON.stringify({
          status: 'active',
          startedAt: '2026-06-01T15:00:00Z',
          daaStart: '1',
        }),
      );
      const res = await soakStatusResponse(new OperationalStubPool(), {
        environment: 'testnet',
        network: 'kaspa-testnet-10',
        version: '0.1.0',
        artifactDir,
      });
      const body = JSON.parse(res.body) as {
        status: string;
        sourceStatus: string;
        completionStatus: string;
        targetReached: boolean;
        targetDurationSeconds: number;
        verdict: string;
      };
      expect(body.status).toBe('completed');
      expect(body.sourceStatus).toBe('active');
      expect(body.completionStatus).toBe('success');
      expect(body.targetReached).toBe(true);
      expect(body.targetDurationSeconds).toBe(86400);
      expect(body.verdict).toContain('Success');
    } finally {
      vi.useRealTimers();
      await rm(artifactDir, { recursive: true, force: true });
    }
  });
});

describe('createKasGraphHttpHandler routing', () => {
  function newCheck(value: { status: number; body: string }): HealthCheck {
    return () =>
      Promise.resolve({
        status: value.status,
        body: value.body,
        contentType: 'application/json',
      });
  }

  // We don't need a real Yoga handler for routing tests; a
  // sentinel function that just records the call is enough.
  function newRecordingYoga(): {
    handler: ReturnType<typeof createKasGraphServer>;
    calls: number;
  } {
    let calls = 0;
    const handler = ((_req: unknown, res: http.ServerResponse): void => {
      calls += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('yoga-was-called');
    }) as unknown as ReturnType<typeof createKasGraphServer>;
    return {
      handler,
      get calls(): number {
        return calls;
      },
    };
  }

  async function listen(handler: http.RequestListener): Promise<{
    base: string;
    close: () => Promise<void>;
  }> {
    const server = http.createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => resolve()),
    );
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) {
      throw new Error('no address bound');
    }
    return {
      base: `http://127.0.0.1:${addr.port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it('routes GET /healthz to the supplied health check', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/healthz`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('routes GET /health to the same supplied health check', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe('ok');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('routes optional /status and /metrics handlers before Yoga', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
      undefined,
      newCheck({ status: 200, body: '{"status":"ok","environment":"testnet"}' }),
      () =>
        Promise.resolve({
          status: 200,
          contentType: 'text/plain',
          body: 'kasgraph_postgres_connected 1\n',
        }),
    );
    const srv = await listen(handler);
    try {
      const status = await fetch(`${srv.base}/status`);
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ status: 'ok', environment: 'testnet' });

      const metrics = await fetch(`${srv.base}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toBe('kasgraph_postgres_connected 1\n');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('routes /soak/status to the soak handler', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
      undefined,
      undefined,
      undefined,
      {},
      nodeSoakHandler(new OperationalStubPool(), {
        environment: 'testnet',
        network: 'kaspa-testnet-10',
        version: '0.1.0',
        artifactDir: '/tmp/no-such-kasgraph-soak',
      }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/soak/status`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; indexedDaaScore: string };
      expect(body.status).toBe('pending');
      expect(body.indexedDaaScore).toBe('467579632');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('serves the visual soak dashboard at / and /soak when soak monitoring is wired', async () => {
    const yoga = newRecordingYoga();
    const soakHandler = nodeSoakHandler(new OperationalStubPool(), {
      environment: 'testnet',
      network: 'kaspa-testnet-10',
      version: '0.1.0',
      artifactDir: '/tmp/no-such-kasgraph-soak',
    });
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
      undefined,
      undefined,
      undefined,
      {},
      soakHandler,
    );
    const srv = await listen(handler);
    try {
      for (const path of ['/', '/soak']) {
        const res = await fetch(`${srv.base}${path}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('Testnet Soak Dashboard');
      }
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('applies configured CORS and handles preflight', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
      undefined,
      undefined,
      undefined,
      { corsAllowedOrigins: ['https://www.kasgraph.com'] },
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/health`, {
        method: 'OPTIONS',
        headers: { origin: 'https://www.kasgraph.com' },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('https://www.kasgraph.com');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('rate limits when configured', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
      undefined,
      undefined,
      undefined,
      { rateLimitPerMinute: 1 },
    );
    const srv = await listen(handler);
    try {
      expect((await fetch(`${srv.base}/health`)).status).toBe(200);
      expect((await fetch(`${srv.base}/health`)).status).toBe(429);
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('routes /healthz?with=qs the same way', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 503, body: '{"status":"unhealthy"}' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/healthz?check=db`);
      expect(res.status).toBe(503);
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('rejects non-GET/HEAD on /healthz with 405', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: 'ok' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/healthz`, { method: 'POST' });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('GET');
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('HEAD /healthz returns status + headers with empty body', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: '{"status":"ok"}' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/healthz`, { method: 'HEAD' });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('');
    } finally {
      await srv.close();
    }
  });

  it('forwards every non-healthz path to the Yoga handler', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: 'ok' }),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/graphql`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('yoga-was-called');
      expect(yoga.calls).toBe(1);
    } finally {
      await srv.close();
    }
  });

  it('routes /subgraphs* to the deploy handler (POST a bundle) — not Yoga', async () => {
    const yoga = newRecordingYoga();
    // A pool that succeeds on the deploy upsert.
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: 'ok' }),
      nodeDeployHandler(new StubPool()),
    );
    const srv = await listen(handler);
    try {
      const res = await fetch(`${srv.base}/subgraphs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subgraphId: 'kasbonds',
          schemaSdl: 'type Bond @entity { id: ID! }',
          manifestJson: { name: 'kasbonds' },
        }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ subgraphId: 'kasbonds', status: 'active' });
      expect(yoga.calls).toBe(0); // deploy route did not fall through to Yoga
    } finally {
      await srv.close();
    }
  });

  it('passes Authorization through the deploy route when bearer auth is configured', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(
      yoga.handler,
      newCheck({ status: 200, body: 'ok' }),
      nodeDeployHandler(new StubPool(), { bearerToken: 'secret' }),
    );
    const srv = await listen(handler);
    try {
      const unauthorized = await fetch(`${srv.base}/subgraphs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not-json',
      });
      expect(unauthorized.status).toBe(401);

      const authorized = await fetch(`${srv.base}/subgraphs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        },
        body: JSON.stringify({
          subgraphId: 'kasbonds',
          schemaSdl: 'type Bond @entity { id: ID! }',
          manifestJson: { name: 'kasbonds' },
        }),
      });
      expect(authorized.status).toBe(200);
      expect(yoga.calls).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('falls through to Yoga when no deploy handler is wired', async () => {
    const yoga = newRecordingYoga();
    const handler = createKasGraphHttpHandler(yoga.handler, newCheck({ status: 200, body: 'ok' }));
    const srv = await listen(handler);
    try {
      await fetch(`${srv.base}/subgraphs`);
      expect(yoga.calls).toBe(1);
    } finally {
      await srv.close();
    }
  });
});

describe('readOptionsFromEnv', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.KASGRAPH_DATABASE_URL;
    delete process.env.HOST;
    delete process.env.PORT;
    delete process.env.GRAPHQL_ENDPOINT;
    delete process.env.GRAPHIQL;
    delete process.env.KASGRAPH_SUBSCRIPTIONS_ENABLED;
    delete process.env.LISTEN_DATABASE_URL;
    delete process.env.KASGRAPH_DEPLOY_TOKEN;
    delete process.env.KASGRAPH_ENVIRONMENT;
    delete process.env.KASGRAPH_NETWORK;
    delete process.env.KASGRAPH_API_VERSION;
    delete process.env.KASGRAPH_CORS_ORIGINS;
    delete process.env.KASGRAPH_RATE_LIMIT_PER_MINUTE;
    delete process.env.KASGRAPH_SOAK_ARTIFACT_DIR;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => readOptionsFromEnv()).toThrow(/DATABASE_URL/);
  });

  it('accepts KASGRAPH_DATABASE_URL as an alternative', () => {
    process.env.KASGRAPH_DATABASE_URL = 'postgres://x';
    const opts = readOptionsFromEnv();
    expect(opts.databaseUrl).toBe('postgres://x');
  });

  it('provides sensible defaults', () => {
    process.env.DATABASE_URL = 'postgres://x';
    const opts = readOptionsFromEnv();
    expect(opts.host).toBe('0.0.0.0');
    expect(opts.port).toBe(4000);
    expect(opts.graphqlEndpoint).toBe('/graphql');
    expect(opts.graphiql).toBe(true);
    expect(opts.subscriptionsEnabled).toBe(true);
    expect(opts.listenDatabaseUrl).toBe('postgres://x');
    expect(opts.deployToken).toBeUndefined();
    expect(opts.environment).toBe('local');
    expect(opts.network).toBeUndefined();
    expect(opts.version).toBe('0.1.0');
    expect(opts.corsAllowedOrigins).toContain('https://www.kasgraph.com');
    expect(opts.rateLimitPerMinute).toBe(0);
    expect(opts.soakArtifactDir).toContain('docs/artifacts/sustained-run/live');
  });

  it('honors PORT/HOST/GRAPHQL_ENDPOINT/GRAPHIQL overrides', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.HOST = '127.0.0.1';
    process.env.PORT = '8080';
    process.env.GRAPHQL_ENDPOINT = '/api/v1';
    process.env.GRAPHIQL = 'false';
    const opts = readOptionsFromEnv();
    expect(opts.host).toBe('127.0.0.1');
    expect(opts.port).toBe(8080);
    expect(opts.graphqlEndpoint).toBe('/api/v1');
    expect(opts.graphiql).toBe(false);
  });

  it('falls back to the default port on a non-numeric PORT', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.PORT = 'twelve';
    const opts = readOptionsFromEnv();
    expect(opts.port).toBe(4000);
  });

  it('KASGRAPH_SUBSCRIPTIONS_ENABLED=false disables subscriptions', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.KASGRAPH_SUBSCRIPTIONS_ENABLED = 'false';
    expect(readOptionsFromEnv().subscriptionsEnabled).toBe(false);
  });

  it('KASGRAPH_SUBSCRIPTIONS_ENABLED accepts the standard truthy values', () => {
    process.env.DATABASE_URL = 'postgres://x';
    for (const truthy of ['1', 'true', 'TRUE', 'True', 'yes']) {
      process.env.KASGRAPH_SUBSCRIPTIONS_ENABLED = truthy;
      expect(readOptionsFromEnv().subscriptionsEnabled).toBe(true);
    }
  });

  it('LISTEN_DATABASE_URL falls back to DATABASE_URL when unset', () => {
    process.env.DATABASE_URL = 'postgres://primary';
    expect(readOptionsFromEnv().listenDatabaseUrl).toBe('postgres://primary');
  });

  it('LISTEN_DATABASE_URL overrides DATABASE_URL for the listener client', () => {
    process.env.DATABASE_URL = 'postgres://primary';
    process.env.LISTEN_DATABASE_URL = 'postgres://replica';
    const opts = readOptionsFromEnv();
    expect(opts.databaseUrl).toBe('postgres://primary');
    expect(opts.listenDatabaseUrl).toBe('postgres://replica');
  });

  it('reads KASGRAPH_DEPLOY_TOKEN for hosted deploy bearer auth', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.KASGRAPH_DEPLOY_TOKEN = 'secret';
    expect(readOptionsFromEnv().deployToken).toBe('secret');
  });

  it('reads operational deployment labels for /status', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.KASGRAPH_ENVIRONMENT = 'testnet';
    process.env.KASGRAPH_NETWORK = 'kaspa-testnet-10';
    process.env.KASGRAPH_API_VERSION = '0.2.0';
    process.env.KASGRAPH_CORS_ORIGINS = 'https://www.kasgraph.com,http://localhost:3000';
    process.env.KASGRAPH_RATE_LIMIT_PER_MINUTE = '120';
    process.env.KASGRAPH_SOAK_ARTIFACT_DIR = '/var/lib/kasgraph/live';
    const opts = readOptionsFromEnv();
    expect(opts.environment).toBe('testnet');
    expect(opts.network).toBe('kaspa-testnet-10');
    expect(opts.version).toBe('0.2.0');
    expect(opts.corsAllowedOrigins).toEqual([
      'https://www.kasgraph.com',
      'http://localhost:3000',
    ]);
    expect(opts.rateLimitPerMinute).toBe(120);
    expect(opts.soakArtifactDir).toBe('/var/lib/kasgraph/live');
  });
});

describe('vi sanity (placeholder to keep `vi` import used in CI strict mode)', () => {
  it('vi is importable', () => {
    expect(typeof vi.fn).toBe('function');
  });
});
