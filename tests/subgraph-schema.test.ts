import { describe, expect, it } from 'vitest';
import { GraphQLObjectType, parse, validate } from 'graphql';
import {
  buildSubgraphSchema,
  buildSubgraphSchemaSdl,
  executeSubgraphQuery,
  subgraphEntities,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

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
    if (next === undefined) throw new Error('MockPool: out of canned responses');
    return { rows: next as TRow[] };
  }
}

const SDL = `
  type Bond @entity {
    id: ID!
    issuer: String!
    faceValueSompi: BigInt!
    redeemed: Boolean!
    holdings: [Holding!] @derivedFrom(field: "bond")
  }

  type Holding @entity {
    id: ID!
    bond: Bond!
    holder: String!
  }

  "Not an entity — a plain helper type, must NOT get query fields."
  type Meta {
    note: String!
  }
`;

describe('subgraphEntities', () => {
  it('finds only the @entity object types, in order', () => {
    expect(subgraphEntities(SDL)).toEqual([
      { name: 'Bond', queryName: 'bond' },
      { name: 'Holding', queryName: 'holding' },
    ]);
  });
});

describe('buildSubgraphSchemaSdl', () => {
  it('generates a by-id + list query per entity, declares directive + scalars', () => {
    const sdl = buildSubgraphSchemaSdl(SDL);
    expect(sdl).toContain('directive @entity on OBJECT');
    expect(sdl).toContain('scalar BigInt');
    expect(sdl).toContain('bond(id: ID!): Bond');
    expect(sdl).toContain('bonds(first: Int = 100): [Bond!]!');
    expect(sdl).toContain('holding(id: ID!): Holding');
    expect(sdl).toContain('holdings(first: Int = 100): [Holding!]!');
    // The non-entity Meta type gets no query field.
    expect(sdl).not.toMatch(/\bmeta\(id: ID!\)/);
  });

  it('throws when the schema has no @entity types', () => {
    expect(() => buildSubgraphSchemaSdl('type Meta { note: String! }')).toThrow(/no .*@entity/);
  });
});

describe('buildSubgraphSchema', () => {
  it('builds a valid executable schema whose Query exposes the entities', () => {
    const schema = buildSubgraphSchema(SDL);
    const query = schema.getQueryType();
    expect(query).toBeDefined();
    const fields = query!.getFields();
    expect(Object.keys(fields).sort()).toEqual(['bond', 'bonds', 'holding', 'holdings']);
    // The Bond type is present with its scalar + relation fields.
    const bond = schema.getType('Bond') as GraphQLObjectType;
    expect(Object.keys(bond.getFields())).toEqual([
      'id',
      'issuer',
      'faceValueSompi',
      'redeemed',
      'holdings',
    ]);
  });

  it('a scalar-field query validates against the generated schema', () => {
    const schema = buildSubgraphSchema(SDL);
    const errors = validate(schema, parse('{ bonds(first: 5) { id issuer faceValueSompi } }'));
    expect(errors).toEqual([]);
  });
});

describe('executeSubgraphQuery', () => {
  it('serves a typed list query from entity_versions payloads', async () => {
    const pool = new MockPool([
      [
        {
          entity_id: 'b1',
          payload: { id: 'b1', issuer: 'alice', faceValueSompi: '1000', redeemed: false },
        },
        // No `id` in the payload → falls back to entity_id ('b2').
        { entity_id: 'b2', payload: { issuer: 'bob', faceValueSompi: '2000', redeemed: true } },
      ],
    ]);
    const res = await executeSubgraphQuery({
      subgraphId: 'kasbonds',
      sdl: SDL,
      query: '{ bonds(first: 5) { id issuer faceValueSompi redeemed } }',
      pool,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      bonds: [
        { id: 'b1', issuer: 'alice', faceValueSompi: '1000', redeemed: false },
        { id: 'b2', issuer: 'bob', faceValueSompi: '2000', redeemed: true },
      ],
    });
    expect(pool.calls[0]!.sql).toMatch(/FROM "kasbonds"\.entity_versions/);
    expect(pool.calls[0]!.values).toEqual(['Bond', 5]);
  });

  it('serves a typed by-id query and binds (entityType, id)', async () => {
    const pool = new MockPool([
      [{ entity_id: 'b1', payload: { id: 'b1', issuer: 'alice', faceValueSompi: '1000', redeemed: false } }],
    ]);
    const res = await executeSubgraphQuery({
      subgraphId: 'kasbonds',
      sdl: SDL,
      query: '{ bond(id: "b1") { id issuer } }',
      pool,
    });
    expect(res.data).toEqual({ bond: { id: 'b1', issuer: 'alice' } });
    expect(pool.calls[0]!.values).toEqual(['Bond', 'b1']);
  });

  it('returns a validation error for an unknown field without querying', async () => {
    const pool = new MockPool([]);
    const res = await executeSubgraphQuery({
      subgraphId: 'kasbonds',
      sdl: SDL,
      query: '{ bonds { nope } }',
      pool,
    });
    expect(res.errors).toBeDefined();
    expect(pool.calls).toHaveLength(0);
  });

  it('resolves a @derivedFrom reverse relation (Bond.holdings)', async () => {
    const pool = new MockPool([
      [{ entity_id: 'b1', payload: { id: 'b1', issuer: 'alice' } }], // bond(id: b1)
      [
        { entity_id: 'h1', payload: { id: 'h1', bond: 'b1', holder: 'alice' } },
        { entity_id: 'h2', payload: { id: 'h2', bond: 'b1', holder: 'bob' } },
      ], // holdings where bond = b1
    ]);
    const res = await executeSubgraphQuery({
      subgraphId: 'kasbonds',
      sdl: SDL,
      query: '{ bond(id: "b1") { id issuer holdings { id holder } } }',
      pool,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      bond: {
        id: 'b1',
        issuer: 'alice',
        holdings: [
          { id: 'h1', holder: 'alice' },
          { id: 'h2', holder: 'bob' },
        ],
      },
    });
    // Second query is the derived-relation filter: payload->>'bond' = 'b1'.
    expect(pool.calls[1]!.sql).toMatch(/payload->>\$2 = \$3/);
    expect(pool.calls[1]!.values).toEqual(['Holding', 'bond', 'b1']);
  });

  it('resolves a direct entity reference by id (Holding.bond)', async () => {
    const pool = new MockPool([
      [{ entity_id: 'h1', payload: { id: 'h1', bond: 'b1', holder: 'alice' } }], // holding(id: h1)
      [{ entity_id: 'b1', payload: { id: 'b1', issuer: 'alice' } }], // bond ref loaded by id
    ]);
    const res = await executeSubgraphQuery({
      subgraphId: 'kasbonds',
      sdl: SDL,
      query: '{ holding(id: "h1") { id holder bond { id issuer } } }',
      pool,
    });
    expect(res.errors).toBeUndefined();
    expect(res.data).toEqual({
      holding: { id: 'h1', holder: 'alice', bond: { id: 'b1', issuer: 'alice' } },
    });
    expect(pool.calls[1]!.values).toEqual(['Bond', 'b1']);
  });
});
