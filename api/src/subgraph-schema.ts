// Per-subgraph GraphQL schema generation.
//
// A subgraph ships a `schema.graphql` declaring its entity types with the
// `@entity` directive (The Graph convention), e.g.
//
//   type Bond @entity { id: ID!  issuer: String!  faceValueSompi: BigInt! }
//
// This module turns that into an *executable* GraphQL SDL: it declares the
// `@entity` directive + the `BigInt`/`JSON` scalars the entities use, keeps the
// entity type definitions verbatim, and auto-generates a `Query` type with a
// by-id lookup and a list field per entity. Resolvers serve these from the
// subgraph's `entity_versions` table (the entity payload IS the field map, so
// default field resolution reads scalar fields directly).
//
// This is the pure schema-generation core; wiring it into `execute_query`
// per-subgraph (and storing each subgraph's SDL at deploy time) is the
// remaining infra. Relation fields (`bond: Bond!`, `holdings: [Holding!]`) are
// kept in the schema but only resolve if the payload carries them — typed
// cross-entity / `@derivedFrom` resolution is a later slice.

import { buildSchema, type GraphQLSchema, Kind, parse } from 'graphql';

/** An entity type discovered in a subgraph schema. */
export interface SubgraphEntity {
  /** The GraphQL type name as declared (e.g. `Bond`). */
  name: string;
  /** Lower-camel form used for the generated query fields (e.g. `bond`). */
  queryName: string;
}

function lowerFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toLowerCase() + s.slice(1);
}

/**
 * The entity types a subgraph schema declares — every object type carrying the
 * `@entity` directive, in declaration order. Throws on a syntactically invalid
 * SDL (via `parse`).
 */
export function subgraphEntities(subgraphSdl: string): SubgraphEntity[] {
  const doc = parse(subgraphSdl);
  const entities: SubgraphEntity[] = [];
  for (const def of doc.definitions) {
    if (def.kind === Kind.OBJECT_TYPE_DEFINITION) {
      const isEntity = (def.directives ?? []).some((d) => d.name.value === 'entity');
      if (isEntity) {
        entities.push({ name: def.name.value, queryName: lowerFirst(def.name.value) });
      }
    }
  }
  return entities;
}

/**
 * Build the executable GraphQL SDL for a subgraph from its `schema.graphql`.
 * Declares the `@entity` directive + `BigInt`/`JSON` scalars, keeps the entity
 * types verbatim, and generates a `Query` with `<entity>(id: ID!): T` and
 * `<entity>s(first: Int = 100): [T!]!` per entity. Throws if no `@entity` type
 * is present (an empty `Query` is invalid GraphQL anyway).
 */
export function buildSubgraphSchemaSdl(subgraphSdl: string): string {
  const entities = subgraphEntities(subgraphSdl);
  if (entities.length === 0) {
    throw new Error('subgraph schema declares no `@entity` types');
  }
  const queryFields = entities
    .map(
      (e) =>
        `  ${e.queryName}(id: ID!): ${e.name}\n` +
        `  ${e.queryName}s(first: Int = 100): [${e.name}!]!`,
    )
    .join('\n');
  return [
    'directive @entity on OBJECT',
    'directive @derivedFrom(field: String!) on FIELD_DEFINITION',
    'scalar BigInt',
    'scalar JSON',
    '',
    subgraphSdl.trim(),
    '',
    'type Query {',
    queryFields,
    '}',
    '',
  ].join('\n');
}

/**
 * Parse + build the executable schema object for a subgraph. Validates the
 * generated SDL is a well-formed GraphQL schema (unresolved type references,
 * etc. throw here). Scalar *implementations* (BigInt/JSON) are attached by the
 * caller the same way `getKasGraphSchema` does for the base schema.
 */
export function buildSubgraphSchema(subgraphSdl: string): GraphQLSchema {
  return buildSchema(buildSubgraphSchemaSdl(subgraphSdl));
}
