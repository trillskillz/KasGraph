import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import {
  createKasGraphHttpHandler,
  createKasGraphServer,
  healthzResponse,
  nodeDeployHandler,
  readOptionsFromEnv,
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
});

describe('vi sanity (placeholder to keep `vi` import used in CI strict mode)', () => {
  it('vi is importable', () => {
    expect(typeof vi.fn).toBe('function');
  });
});
