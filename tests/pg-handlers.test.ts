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
  it('lists active deployed subgraphs (registry-sourced) with indexed-block counts', async () => {
    const pool = new MockPool([
      [
        { subgraph: 'kasbonds', display_name: 'KasBonds', blocks_indexed: 12345 },
        // No manifest name → id is the display fallback; never-indexed → 0.
        { subgraph: 'network_stats', display_name: null, blocks_indexed: 0 },
      ],
    ]);
    const handlers = new PgMcpHandlers(pool);
    const got = await handlers.list_subgraphs({});

    const call = lastCall(pool);
    expect(call.sql).toMatch(/FROM kasgraph_subgraph s/);
    expect(call.sql).toMatch(/LEFT JOIN/);
    expect(call.sql).toMatch(/status <> 'removed'/);
    expect(call.values).toEqual([]);
    expect(got).toEqual([
      { id: 'kasbonds', name: 'KasBonds', blocks_indexed: 12345 },
      { id: 'network_stats', name: 'network_stats', blocks_indexed: 0 },
    ]);
  });

  it('adds a LIKE filter when a keyword is provided (lowercased)', async () => {
    const pool = new MockPool([
      [{ subgraph: 'kasbonds', display_name: 'KasBonds', blocks_indexed: 12345 }],
    ]);
    const handlers = new PgMcpHandlers(pool);
    const got = await handlers.list_subgraphs({ keyword: 'KasB' });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/LOWER\(s\.subgraph\) LIKE \$1/);
    expect(call.values).toEqual(['%kasb%']);
    expect(got).toHaveLength(1);
  });

  it('coerces a string-shaped COUNT to a number', async () => {
    const pool = new MockPool([
      [{ subgraph: 'k', display_name: null, blocks_indexed: '42' }],
    ]);
    const got = await new PgMcpHandlers(pool).list_subgraphs({});
    expect(got[0]!.blocks_indexed).toBe(42);
  });
});

describe('PgMcpHandlers — get_schema', () => {
  it('returns the canonical KasGraph base schema for an undeployed subgraph', async () => {
    // The registry lookup returns no row → base/meta schema.
    const pool = new MockPool([[]]);
    const got = await new PgMcpHandlers(pool).get_schema({
      subgraph_id: 'any',
    });
    expect(got.subgraph_id).toBe('any');
    expect(got.schema_sdl).toContain('type CommittedBlock');
    expect(got.schema_sdl).toContain('scalar BigInt');
    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]!.sql).toMatch(/FROM kasgraph_subgraph/);
  });

  it('returns the deployed subgraph\'s own typed schema', async () => {
    const pool = new MockPool([
      [
        {
          schema_sdl: 'type Bond @entity { id: ID! owner: String! }',
          manifest_json: { name: 'kasbonds' },
          wasm_sha256: null,
        },
      ],
    ]);
    const got = await new PgMcpHandlers(pool).get_schema({ subgraph_id: 'kasbonds' });
    // The generated SDL exposes the entity's typed queries, not the base meta types.
    expect(got.schema_sdl).toContain('bond(id: ID!): Bond');
    expect(got.schema_sdl).toContain('bonds(first: Int = 100): [Bond!]!');
    expect(got.schema_sdl).not.toContain('type CommittedBlock');
  });
});

describe('PgMcpHandlers — execute_query', () => {
  it('falls back to the base meta gateway for an undeployed subgraph', async () => {
    // 1st query: registry lookup (empty → undeployed). 2nd: the base resolver.
    const pool = new MockPool([
      [],
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
    expect(pool.calls[0]!.sql).toMatch(/FROM kasgraph_subgraph/);
  });

  it('routes a deployed subgraph query to its own typed schema', async () => {
    // 1st query: registry lookup returns the deployed SDL. 2nd: the typed
    // entity query against "<id>".entity_versions.
    const pool = new MockPool([
      [
        {
          schema_sdl: 'type Bond @entity { id: ID! owner: String! }',
          manifest_json: { name: 'kasbonds' },
          wasm_sha256: null,
        },
      ],
      [{ entity_id: 'b1', payload: { id: 'b1', owner: 'alice' } }],
    ]);
    const res = await new PgMcpHandlers(pool).execute_query({
      subgraph_id: 'kasbonds',
      query: '{ bond(id: "b1") { id owner } }',
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({ bond: { id: 'b1', owner: 'alice' } });
    // The typed query hits the subgraph's own entity_versions table.
    expect(pool.calls[1]!.sql).toMatch(/"kasbonds"\.entity_versions/);
  });

  it('surfaces GraphQL parse errors as response.errors', async () => {
    // Registry lookup (undeployed) then the base gateway parse-errors before querying.
    const pool = new MockPool([[]]);
    const res = await new PgMcpHandlers(pool).execute_query({
      subgraph_id: 'x',
      query: '{ bad',
    });
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
    expect(pool.calls).toHaveLength(1); // only the registry lookup
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
