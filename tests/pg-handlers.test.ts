import { describe, expect, it } from 'vitest';
import {
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';
import {
  McpHandlerNotImplementedError,
  NOT_IMPLEMENTED_TOOLS,
  PgMcpHandlers,
} from '../mcp/src/index.js';

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
        `MockPool: ran out of canned responses after ${this.calls.length} calls`,
      );
    }
    return { rows: next as TRow[] };
  }
}

function lastCall(pool: MockPool) {
  const c = pool.calls.at(-1);
  if (c === undefined) throw new Error('no calls recorded');
  return c;
}

describe('PgMcpHandlers — list_subgraphs', () => {
  it('groups by subgraph with no WHERE clause when no keyword', async () => {
    const pool = new MockPool([
      [
        { subgraph: 'kasbonds', blocks_indexed: 12345 },
        { subgraph: 'opensilver_patterns', blocks_indexed: 67890 },
      ],
    ]);
    const handlers = new PgMcpHandlers(pool);
    const got = await handlers.list_subgraphs({});

    const call = lastCall(pool);
    expect(call.sql).toMatch(/FROM kasgraph_committed_block/);
    expect(call.sql).toMatch(/GROUP BY subgraph/);
    expect(call.sql).not.toMatch(/WHERE/);
    expect(call.values).toEqual([]);
    expect(got).toEqual([
      { id: 'kasbonds', name: 'kasbonds', blocks_indexed: 12345 },
      {
        id: 'opensilver_patterns',
        name: 'opensilver_patterns',
        blocks_indexed: 67890,
      },
    ]);
  });

  it('adds a LIKE filter when a keyword is provided (lowercased)', async () => {
    const pool = new MockPool([
      [{ subgraph: 'kasbonds', blocks_indexed: 12345 }],
    ]);
    const handlers = new PgMcpHandlers(pool);
    const got = await handlers.list_subgraphs({ keyword: 'KasB' });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/WHERE LOWER\(subgraph\) LIKE \$1/);
    expect(call.values).toEqual(['%kasb%']);
    expect(got).toHaveLength(1);
  });

  it('coerces a string-shaped COUNT to a number', async () => {
    const pool = new MockPool([[{ subgraph: 'k', blocks_indexed: '42' }]]);
    const got = await new PgMcpHandlers(pool).list_subgraphs({});
    expect(got[0]!.blocks_indexed).toBe(42);
  });
});

describe('PgMcpHandlers — get_schema', () => {
  it('returns the canonical KasGraph SDL for any subgraph id', async () => {
    // No pool query is issued for the schema endpoint today, so
    // an empty MockPool is fine.
    const pool = new MockPool([]);
    const got = await new PgMcpHandlers(pool).get_schema({
      subgraph_id: 'any',
    });
    expect(got.subgraph_id).toBe('any');
    expect(got.schema_sdl).toContain('type CommittedBlock');
    expect(got.schema_sdl).toContain('scalar BigInt');
    expect(pool.calls).toHaveLength(0);
  });
});

describe('PgMcpHandlers — execute_query', () => {
  it('round-trips a real GraphQL query through the gateway', async () => {
    // One canned response for the GraphQL resolver under the hood.
    const pool = new MockPool([
      [
        {
          subgraph: 'kasbonds',
          block_hash: 'h1',
          daa_score: '100',
          served_by: 'wrpc',
          committed_at: '2026-05-26T12:00:00Z',
        },
      ],
    ]);
    const handlers = new PgMcpHandlers(pool);
    const res = await handlers.execute_query({
      subgraph_id: 'kasbonds',
      query: `query Q($s: String!) {
        committedBlocks(subgraph: $s, first: 1) { blockHash daaScore }
      }`,
      variables: { s: 'kasbonds' },
    });
    expect(res.errors).toBeUndefined();
    expect(
      (res.data as { committedBlocks: Array<{ blockHash: string }> })
        .committedBlocks[0]?.blockHash,
    ).toBe('h1');
  });

  it('surfaces GraphQL parse errors as response.errors', async () => {
    const pool = new MockPool([]); // no query should be issued
    const res = await new PgMcpHandlers(pool).execute_query({
      subgraph_id: 'x',
      query: '{ bad',
    });
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(pool.calls).toHaveLength(0);
  });
});

describe('PgMcpHandlers — search_by_pattern', () => {
  it('binds (pattern, limit) and applies ORDER BY block_daa_score DESC', async () => {
    const pool = new MockPool([
      [
        {
          tx_hash: 't1',
          output_index: 0,
          block_daa_score: '100',
          covenant_id: '0xabc',
        },
        {
          tx_hash: 't2',
          output_index: 1,
          block_daa_score: '99',
          covenant_id: null,
        },
      ],
    ]);
    const got = await new PgMcpHandlers(pool).search_by_pattern({
      pattern_name: 'OpenSilverVault',
    });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/WHERE detector_kind = \$1/);
    expect(call.sql).toMatch(/ORDER BY block_daa_score DESC/);
    expect(call.values).toEqual(['OpenSilverVault', 100]); // default limit
    expect(got).toHaveLength(2);
    expect(got[0]!.covenant_id).toBe('0xabc');
    expect('covenant_id' in got[1]!).toBe(false);
    expect(got[0]!.block_daa_score).toBe(100);
  });

  it('clamps limit into [1, 1000]', async () => {
    const cases: Array<{ limit?: number; expected: number }> = [
      { expected: 100 },
      { limit: 0, expected: 100 },
      { limit: 99999, expected: 1000 },
      { limit: 5, expected: 5 },
    ];
    for (const c of cases) {
      const pool = new MockPool([[]]);
      const args =
        c.limit !== undefined
          ? { pattern_name: 'X', limit: c.limit }
          : { pattern_name: 'X' };
      await new PgMcpHandlers(pool).search_by_pattern(args);
      expect(lastCall(pool).values?.[1]).toBe(c.expected);
    }
  });
});

describe('PgMcpHandlers — get_covenant_lineage', () => {
  it('returns just the covenant_id with empty lineage when head is missing', async () => {
    const pool = new MockPool([[]]);
    const got = await new PgMcpHandlers(pool).get_covenant_lineage({
      covenant_id: 'nope',
    });
    expect(got.covenant_id).toBe('nope');
    expect(got.lineage).toEqual([]);
    expect(got.genesis_tx).toBeUndefined();
    expect(pool.calls).toHaveLength(1);
  });

  it('joins head + entries when the covenant exists', async () => {
    const pool = new MockPool([
      [
        {
          covenant_id: '0xabc',
          genesis_tx: 'gen',
          current_utxo: 'spend:0',
          last_seen_daa: '101',
          lineage_count: 2,
        },
      ],
      [
        { seq: 0, tx_hash: 'gen', output_index: 0, daa_score: '99', state_bytes: '' },
        {
          seq: 1,
          tx_hash: 'spend',
          output_index: 0,
          daa_score: '100',
          state_bytes: Buffer.from([0xCA, 0xFE]),
        },
      ],
    ]);
    const got = await new PgMcpHandlers(pool).get_covenant_lineage({
      covenant_id: '0xabc',
    });
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0]!.sql).toMatch(/FROM kasgraph_covenant_lineage_head/);
    expect(pool.calls[1]!.sql).toMatch(/FROM kasgraph_covenant_lineage_row/);
    expect(got.covenant_id).toBe('0xabc');
    expect(got.genesis_tx).toBe('gen');
    expect(got.current_utxo).toBe('spend:0');
    expect(got.lineage).toHaveLength(2);
    expect(got.lineage[1]!.state_bytes_hex).toBe('cafe');
    expect('state_bytes_hex' in got.lineage[0]!).toBe(false);
  });
});

describe('PgMcpHandlers — not-implemented tools', () => {
  it('NOT_IMPLEMENTED_TOOLS lists the three unbacked tools', () => {
    expect([...NOT_IMPLEMENTED_TOOLS]).toEqual([
      'get_address_activity',
      'find_subgraphs_for_address',
      'query_natural_language',
    ]);
  });

  it.each(['get_address_activity', 'find_subgraphs_for_address', 'query_natural_language'])(
    '%s throws McpHandlerNotImplementedError',
    async (tool) => {
      const pool = new MockPool([]);
      const handlers = new PgMcpHandlers(pool);
      // Minimal valid inputs per tool.
      const minimalInput =
        tool === 'query_natural_language'
          ? { prompt: 'find bonds' }
          : { address: 'kaspa:x' };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (handlers as any)[tool] as (input: unknown) => Promise<unknown>;
      await expect(fn.call(handlers, minimalInput)).rejects.toBeInstanceOf(
        McpHandlerNotImplementedError,
      );
      expect(pool.calls).toHaveLength(0);
    },
  );
});
