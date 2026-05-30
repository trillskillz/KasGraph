import { describe, expect, it } from 'vitest';
import {
  PgGatewayResolvers,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

// Mock pg.Pool: records every (sql, params) tuple and replays a
// queue of canned `rows[]` results in order. One canned result is
// consumed per query() call; if the queue runs out the test gets a
// clear failure.
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
      throw new Error(`MockPool: ran out of canned responses after ${this.calls.length} calls`);
    }
    return { rows: next as TRow[] };
  }
}

function lastCall(pool: MockPool): { sql: string; values: ReadonlyArray<unknown> | undefined } {
  const c = pool.calls.at(-1);
  if (c === undefined) throw new Error('no calls recorded');
  return c;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

describe('PgGatewayResolvers — committedBlock', () => {
  it('builds a single-row SELECT and binds (subgraph, hash)', async () => {
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
    const resolver = new PgGatewayResolvers(pool);
    const got = await resolver.committedBlock({ subgraph: 'kasbonds', hash: 'h1' });
    const call = lastCall(pool);
    expect(normalizeSql(call.sql)).toMatch(/FROM kasgraph_committed_block/);
    expect(call.sql).toMatch(/WHERE subgraph = \$1 AND block_hash = \$2/);
    expect(call.values).toEqual(['kasbonds', 'h1']);
    expect(got).toMatchObject({
      subgraph: 'kasbonds',
      blockHash: 'h1',
      daaScore: '100',
      servedBy: 'wrpc',
    });
  });

  it('returns null when the row is missing', async () => {
    const pool = new MockPool([[]]);
    const resolver = new PgGatewayResolvers(pool);
    const got = await resolver.committedBlock({ subgraph: 'kasbonds', hash: 'missing' });
    expect(got).toBeNull();
  });

  it('serializes BIGINT/Date columns through bigIntString + isoString', async () => {
    const pool = new MockPool([
      [
        {
          subgraph: 'k',
          block_hash: 'h',
          // pg can deliver BIGINT as string OR number depending on
          // type-parser config; both must serialize to a string.
          daa_score: 1234,
          served_by: 'wrpc',
          committed_at: new Date('2026-05-26T12:34:56Z'),
        },
      ],
    ]);
    const got = await new PgGatewayResolvers(pool).committedBlock({
      subgraph: 'k',
      hash: 'h',
    });
    expect(got!.daaScore).toBe('1234');
    expect(got!.committedAt).toBe('2026-05-26T12:34:56.000Z');
  });
});

describe('PgGatewayResolvers — committedBlocks', () => {
  it('orders by daa_score DESC and applies a bounded LIMIT', async () => {
    const pool = new MockPool([[]]);
    await new PgGatewayResolvers(pool).committedBlocks({ subgraph: 'kasbonds', first: 25 });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/ORDER BY daa_score DESC/);
    expect(call.sql).toMatch(/LIMIT \$2/);
    expect(call.values).toEqual(['kasbonds', 25]);
  });

  it('clamps `first` to the [1, 1000] window and defaults missing values', async () => {
    const cases: Array<{ first?: number; expected: number }> = [
      { expected: 50 },
      { first: 0, expected: 50 },
      { first: -3, expected: 50 },
      { first: 9999, expected: 1000 },
      { first: 25, expected: 25 },
    ];
    for (const c of cases) {
      const pool = new MockPool([[]]);
      const args = c.first !== undefined ? { subgraph: 'k', first: c.first } : { subgraph: 'k' };
      await new PgGatewayResolvers(pool).committedBlocks(args);
      const call = lastCall(pool);
      expect(call.values?.[1]).toBe(c.expected);
    }
  });
});

describe('PgGatewayResolvers — poiCheckpoints', () => {
  it('adds fromDaa / toDaa clauses only when provided', async () => {
    const pool = new MockPool([[]]);
    await new PgGatewayResolvers(pool).poiCheckpoints({ subgraph: 'k' });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/WHERE subgraph = \$1/);
    expect(call.sql).not.toMatch(/block_daa_score >=/);
    expect(call.sql).not.toMatch(/block_daa_score <=/);
    expect(call.values).toEqual(['k', 50]);
  });

  it('builds the right parameter sequence with both bounds set', async () => {
    const pool = new MockPool([[]]);
    await new PgGatewayResolvers(pool).poiCheckpoints({
      subgraph: 'k',
      fromDaa: '10',
      toDaa: '20',
      first: 5,
    });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/block_daa_score >= \$2/);
    expect(call.sql).toMatch(/block_daa_score <= \$3/);
    expect(call.sql).toMatch(/LIMIT \$4/);
    expect(call.values).toEqual(['k', '10', '20', 5]);
  });

  it('renders poi_hash as hex regardless of buffer vs string vs uint8 shape', async () => {
    const pool = new MockPool([
      [
        { subgraph: 'k', block_daa_score: '10', poi_hash: Buffer.from([0xDE, 0xAD]) },
        { subgraph: 'k', block_daa_score: '11', poi_hash: new Uint8Array([0xBE, 0xEF]) },
        { subgraph: 'k', block_daa_score: '12', poi_hash: 'cafebabe' },
      ],
    ]);
    const got = await new PgGatewayResolvers(pool).poiCheckpoints({ subgraph: 'k' });
    expect(got.map((c) => c.poiHashHex)).toEqual(['dead', 'beef', 'cafebabe']);
  });
});

describe('PgGatewayResolvers — detectedPatterns', () => {
  it('builds the kind filter only when supplied', async () => {
    const noKind = new MockPool([[]]);
    await new PgGatewayResolvers(noKind).detectedPatterns({ subgraph: 'k' });
    expect(lastCall(noKind).sql).not.toMatch(/detector_kind =/);

    const withKind = new MockPool([[]]);
    await new PgGatewayResolvers(withKind).detectedPatterns({
      subgraph: 'k',
      kind: 'OpenSilverVault',
    });
    const call = lastCall(withKind);
    expect(call.sql).toMatch(/detector_kind = \$2/);
    expect(call.values).toEqual(['k', 'OpenSilverVault', 50]);
  });

  it('omits covenantId and payload from the response when DB columns are null', async () => {
    const pool = new MockPool([
      [
        {
          subgraph: 'k',
          block_hash: 'h',
          block_daa_score: '10',
          tx_hash: 't',
          output_index: 0,
          detector_kind: 'OpenSilverVault',
          covenant_id: null,
          payload: null,
        },
      ],
    ]);
    const got = await new PgGatewayResolvers(pool).detectedPatterns({ subgraph: 'k' });
    expect(got).toHaveLength(1);
    const hit = got[0]!;
    expect('covenantId' in hit).toBe(false);
    expect('payload' in hit).toBe(false);
  });
});

describe('PgGatewayResolvers — covenantLineage', () => {
  it('returns null when the head row is missing', async () => {
    const pool = new MockPool([[]]);
    const got = await new PgGatewayResolvers(pool).covenantLineage({
      covenantId: 'nope',
    });
    expect(got).toBeNull();
    // Only the head query should have been issued; no entries
    // lookup follows a missing head.
    expect(pool.calls).toHaveLength(1);
  });

  it('issues a head query then an entries query in order', async () => {
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
    const got = await new PgGatewayResolvers(pool).covenantLineage({
      covenantId: '0xabc',
    });
    expect(pool.calls).toHaveLength(2);
    expect(pool.calls[0]?.sql).toMatch(/FROM kasgraph_covenant_lineage_head/);
    expect(pool.calls[1]?.sql).toMatch(/FROM kasgraph_covenant_lineage_row/);
    expect(got).not.toBeNull();
    expect(got!.covenantId).toBe('0xabc');
    expect(got!.lineageCount).toBe(2);
    expect(got!.lastSeenDaa).toBe('101');
    expect(got!.entries).toHaveLength(2);
    expect(got!.entries[1]!.stateBytesHex).toBe('cafe');
    // Empty state bytes omitted entirely (exactOptionalPropertyTypes).
    expect('stateBytesHex' in got!.entries[0]!).toBe(false);
  });
});

describe('PgGatewayResolvers — entity / entities', () => {
  it('reads one entity from the subgraph schema, binds (entityType, id)', async () => {
    const pool = new MockPool([
      [{ entity_type: 'Bond', entity_id: 'b1', block_daa_score: '200', payload: { n: 7 } }],
    ]);
    const got = await new PgGatewayResolvers(pool).entity({
      subgraph: 'kasbonds',
      entityType: 'Bond',
      id: 'b1',
    });
    const call = lastCall(pool);
    expect(call.sql).toMatch(/FROM "kasbonds"\.entity_versions/);
    expect(call.sql).toMatch(/WHERE entity_type = \$1 AND entity_id = \$2/);
    expect(normalizeSql(call.sql)).toMatch(/ORDER BY block_daa_score DESC LIMIT 1/);
    expect(call.values).toEqual(['Bond', 'b1']);
    expect(got).toEqual({
      entityType: 'Bond',
      entityId: 'b1',
      data: { n: 7 },
      blockDaaScore: '200',
    });
  });

  it('returns null when the entity is missing', async () => {
    const pool = new MockPool([[]]);
    const got = await new PgGatewayResolvers(pool).entity({
      subgraph: 'kasbonds',
      entityType: 'Bond',
      id: 'nope',
    });
    expect(got).toBeNull();
  });

  it('lists latest-per-id entities with DISTINCT ON and a bounded LIMIT', async () => {
    const pool = new MockPool([
      [
        { entity_type: 'Bond', entity_id: 'b1', block_daa_score: '200', payload: { v: 1 } },
        { entity_type: 'Bond', entity_id: 'b2', block_daa_score: '150', payload: { v: 2 } },
      ],
    ]);
    const got = await new PgGatewayResolvers(pool).entities({
      subgraph: 'kasbonds',
      entityType: 'Bond',
      first: 25,
    });
    const call = lastCall(pool);
    expect(normalizeSql(call.sql)).toMatch(/SELECT DISTINCT ON \(entity_id\)/);
    expect(call.sql).toMatch(/FROM "kasbonds"\.entity_versions/);
    expect(normalizeSql(call.sql)).toMatch(/ORDER BY entity_id, block_daa_score DESC LIMIT \$2/);
    expect(call.values).toEqual(['Bond', 25]);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ entityId: 'b1', data: { v: 1 } });
  });

  it('rejects an injection-unsafe subgraph id before querying', async () => {
    const pool = new MockPool([]);
    await expect(
      new PgGatewayResolvers(pool).entity({
        subgraph: 'evil"; DROP TABLE x; --',
        entityType: 'Bond',
        id: 'b1',
      }),
    ).rejects.toThrow(/invalid subgraph id/);
    // No query was issued.
    expect(pool.calls).toHaveLength(0);
  });
});
