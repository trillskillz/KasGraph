import { describe, expect, it } from 'vitest';
import {
  createKasGraphServer,
  type GatewayResolvers,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

// Recording mock pool; same shape as the one in
// pg-resolvers.test.ts so an end-to-end test through the Yoga
// handler doesn't need a real Postgres.
class MockPool implements PgPoolLike {
  readonly calls: Array<{ sql: string; values: ReadonlyArray<unknown> | undefined }> = [];
  private readonly responses: Array<QueryResultRow[]>;

  constructor(responses: Array<QueryResultRow[]>) {
    this.responses = [...responses];
  }

  async query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>> {
    this.calls.push({ sql: text, values });
    const next = this.responses.shift();
    if (next === undefined) {
      throw new Error(
        `MockPool: out of canned responses after ${this.calls.length} calls`,
      );
    }
    return { rows: next as TRow[] };
  }
}

class InMemoryResolvers implements GatewayResolvers {
  async committedBlock() {
    return null;
  }
  async committedBlocks() {
    return [
      {
        subgraph: 'kasbonds',
        blockHash: 'h1',
        daaScore: '100',
        servedBy: 'wrpc',
        committedAt: '2026-05-28T08:00:00Z',
      },
    ];
  }
  async poiCheckpoints() {
    return [];
  }
  async detectedPatterns() {
    return [];
  }
  async covenantLineage() {
    return null;
  }
}

async function postQuery(
  yoga: ReturnType<typeof createKasGraphServer>,
  body: { query: string; variables?: Record<string, unknown> },
): Promise<{ status: number; json: unknown }> {
  const res = await yoga.fetch('http://localhost/graphql', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // GraphQL-over-HTTP spec — Yoga 5 enforces it.
      accept: 'application/graphql-response+json, application/json',
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as unknown;
  return { status: res.status, json };
}

describe('@kasgraph/api — Yoga HTTP handler', () => {
  it('GET / serves GraphiQL when enabled (default)', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
    });
    const res = await yoga.fetch('http://localhost/graphql', {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).toContain('graphiql');
  });

  it('POST executes a query against the supplied resolvers', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
    });
    const { status, json } = await postQuery(yoga, {
      query: `query Q($s: String!) {
        committedBlocks(subgraph: $s, first: 1) { blockHash daaScore }
      }`,
      variables: { s: 'kasbonds' },
    });
    expect(status).toBe(200);
    const data = (json as { data: { committedBlocks: Array<{ blockHash: string }> } })
      .data;
    expect(data.committedBlocks[0]?.blockHash).toBe('h1');
  });

  it('POST end-to-end through PgGatewayResolvers wires the mock pool', async () => {
    const pool = new MockPool([
      [
        {
          subgraph: 'kasbonds',
          block_hash: 'h1',
          daa_score: '100',
          served_by: 'wrpc',
          committed_at: '2026-05-28T08:00:00Z',
        },
      ],
    ]);
    // No explicit resolvers — defaults to new PgGatewayResolvers(pool).
    const yoga = createKasGraphServer({ pool });
    const { status, json } = await postQuery(yoga, {
      query: `{ committedBlock(subgraph: "kasbonds", hash: "h1") {
        blockHash daaScore servedBy
      } }`,
    });
    expect(status).toBe(200);
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.sql).toMatch(/FROM kasgraph_committed_block/);
    const data = (json as { data: { committedBlock: { blockHash: string } } }).data;
    expect(data.committedBlock.blockHash).toBe('h1');
  });

  it('POST surfaces GraphQL validation errors in the body', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
    });
    const { status, json } = await postQuery(yoga, {
      query: '{ notAField }',
    });
    // Per the GraphQL-over-HTTP spec, Yoga returns 400 for
    // validation errors when the Accept header includes
    // `application/graphql-response+json`. Legacy clients that
    // only send `application/json` get 200 with the same body.
    // Either is acceptable; the errors[] payload is what
    // matters.
    expect([200, 400]).toContain(status);
    const errors = (json as { errors?: Array<{ message: string }> }).errors;
    expect(errors).toBeDefined();
    expect(errors!.length).toBeGreaterThan(0);
    expect(errors![0]!.message).toMatch(/Cannot query/);
  });

  it('POST __schema introspection round-trips', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
    });
    const { status, json } = await postQuery(yoga, {
      query: '{ __schema { queryType { name } } }',
    });
    expect(status).toBe(200);
    expect(
      (json as { data: { __schema: { queryType: { name: string } } } }).data
        .__schema.queryType.name,
    ).toBe('Query');
  });

  it('graphiql:false disables the GraphiQL response on GET', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
      graphiql: false,
    });
    const res = await yoga.fetch('http://localhost/graphql', {
      method: 'GET',
      headers: { accept: 'text/html' },
    });
    // Yoga responds with a non-OK status when GraphiQL is off and
    // the request isn't a GraphQL query — the body should not
    // contain the GraphiQL UI string.
    if (res.status === 200) {
      const text = await res.text();
      expect(text.toLowerCase()).not.toContain('graphiql');
    } else {
      // Yoga returns 406 when GraphiQL is off and the request
      // doesn't ask for a GraphQL-content-negotiated response.
      expect([400, 404, 405, 406]).toContain(res.status);
    }
  });

  it('graphqlEndpoint override routes the handler to a custom path', async () => {
    const yoga = createKasGraphServer({
      pool: new MockPool([]),
      resolvers: new InMemoryResolvers(),
      graphqlEndpoint: '/api/v1/graphql',
    });
    const res = await yoga.fetch('http://localhost/api/v1/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql-response+json, application/json',
      },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(res.status).toBe(200);
  });
});
