import { describe, expect, it } from 'vitest';
import { GraphQLObjectType, parse, validate } from 'graphql';
import {
  buildSubgraphSchema,
  buildSubgraphSchemaSdl,
  subgraphEntities,
} from '../api/src/index.js';

const SDL = `
  type Bond @entity {
    id: ID!
    issuer: String!
    faceValueSompi: BigInt!
    redeemed: Boolean!
    holdings: [Holding!]
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
