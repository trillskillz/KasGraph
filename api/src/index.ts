// @kasgraph/api — GraphQL gateway.
//
// Per PLAN.md Phase 3.1:
//   - Auto-generate Postgres schema from a subgraph's schema.graphql
//   - Auto-generate resolvers
//   - Auto-handle pagination, filtering, ordering, derived fields
//   - Block-specific queries: `block: { number: 123 }` for historical state
//   - Cross-subgraph federation
//
// This module ships the canonical KasGraph schema (the entities the
// indexer always writes — CommittedBlock, PoiCheckpoint,
// DetectedPattern, CovenantLineage) plus a `GatewayResolvers`
// contract and `executeGraphQLQuery` dispatcher. Per-subgraph
// schemas extend this base via codegen in a later slice.
//
// The choice of GraphQL framework — Apollo vs Yoga vs Mercurius —
// is deliberately *not* baked in here. This module talks directly
// to the reference `graphql` engine; any of the frameworks can wrap
// it as an HTTP transport (Yoga is the recommended default per
// PLAN.md once the WebSocket subscriptions in Phase 3.4 land).

import {
  buildSchema,
  execute,
  getNamedType,
  GraphQLError,
  GraphQLObjectType,
  GraphQLScalarType,
  Kind,
  parse,
  validate,
  type GraphQLSchema,
  type ExecutionResult,
} from 'graphql';

import {
  subgraphEntitiesOfType,
  subgraphEntitiesWhere,
  subgraphEntityById,
  type PgPoolLike,
} from './pg-resolvers.js';
import { buildSubgraphSchema, subgraphEntities } from './subgraph-schema.js';

export const KASGRAPH_API_VERSION = '0.1.0';

// Postgres-backed `GatewayResolvers` impl (Phase 2.4 + 2.5 schema).
export {
  PgGatewayResolvers,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from './pg-resolvers.js';

// Per-subgraph schema generation from a subgraph's `schema.graphql`.
export {
  buildSubgraphSchema,
  buildSubgraphSchemaSdl,
  subgraphEntities,
  type SubgraphEntity,
} from './subgraph-schema.js';

// HTTP transport (graphql-yoga).
export {
  createKasGraphServer,
  type KasGraphServer,
  type KasGraphServerOptions,
} from './server.js';

// Subscription source contract + in-memory impl.
export {
  InMemorySubscriptionSource,
  matches as detectedPatternsFilterMatches,
  type DetectedPatternsFilter,
  type SubscriptionSource,
} from './subscriptions.js';

// Postgres LISTEN/NOTIFY-backed subscription source.
export {
  DETECTED_PATTERN_CHANNEL,
  PgListenSource,
  type PgListenClient,
  type PgListenSourceOptions,
  type PgNotificationMessage,
} from './pg-listen.js';

// Operator entry: routing + healthz + env-driven bootstrap.
export {
  createKasGraphHttpHandler,
  healthzResponse,
  readOptionsFromEnv,
  runKasGraphServer,
  type HealthzResponse,
  type HealthCheck,
  type NodeHttpHandler,
  type RunServerOptions,
  type RunningServer,
} from './main.js';

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------

export interface GatewayConfig {
  /** Postgres connection string (multi-tenant; per-subgraph schemas live inside). */
  databaseUrl: string;
  /** Optional federation map: aliases each subgraph id is reachable under. */
  subgraphAliases?: Record<string, string>;
  /** Hosted-service rate limit (queries per minute per API key). */
  rateLimitPerMinute?: number;
}

// ---------------------------------------------------------------
// Entity types (mirrors the Phase 2.4 + 2.5 Postgres schema)
// ---------------------------------------------------------------

export interface CommittedBlock {
  subgraph: string;
  blockHash: string;
  daaScore: string; // BigInt over the wire
  servedBy: string;
  committedAt: string; // ISO timestamp
}

export interface PoiCheckpoint {
  subgraph: string;
  blockDaaScore: string;
  poiHashHex: string;
}

export interface DetectedPattern {
  subgraph: string;
  blockHash: string;
  blockDaaScore: string;
  txHash: string;
  outputIndex: number;
  detectorKind: string;
  covenantId?: string;
  payload?: Record<string, unknown>;
}

export interface CovenantLineageEntry {
  seq: number;
  txHash: string;
  outputIndex: number;
  daaScore: string;
  stateBytesHex?: string;
}

export interface CovenantLineage {
  covenantId: string;
  genesisTx: string;
  currentUtxo: string;
  lineageCount: number;
  lastSeenDaa: string;
  entries: CovenantLineageEntry[];
}

/// One mapping-emitted entity, at its latest committed version. `data` is the
/// subgraph-defined entity state (schema-less JSON); `blockDaaScore` is the
/// version height.
export interface Entity {
  entityType: string;
  entityId: string;
  data?: Record<string, unknown>;
  blockDaaScore: string; // BigInt over the wire
}

/// A detected covenant spend: a block input consumed a tracked covenant UTXO.
/// `operation` is not stored on the record (its effect lands in entity state);
/// this is the protocol-observable spend itself.
export interface CovenantSpend {
  spendingTxHash: string;
  previousTxHash: string;
  previousOutputIndex: number;
  blockDaaScore: string;
  detectorKind: string;
  covenantId?: string;
  spentValueSompi: string;
  successorCovenantId?: string;
}

// ---------------------------------------------------------------
// Query argument shapes
// ---------------------------------------------------------------

export interface CommittedBlockArgs {
  subgraph: string;
  hash: string;
}

export interface CommittedBlocksArgs {
  subgraph: string;
  first?: number;
}

export interface PoiCheckpointsArgs {
  subgraph: string;
  fromDaa?: string;
  toDaa?: string;
  first?: number;
}

export interface DetectedPatternsArgs {
  subgraph: string;
  kind?: string;
  first?: number;
}

export interface CovenantLineageArgs {
  covenantId: string;
}

export interface EntityArgs {
  subgraph: string;
  entityType: string;
  id: string;
}

export interface EntitiesArgs {
  subgraph: string;
  entityType: string;
  first?: number;
}

export interface CovenantSpendsArgs {
  subgraph: string;
  covenantId?: string;
  first?: number;
}

// ---------------------------------------------------------------
// Resolver contract — production impl talks to Postgres, test impl
// is in-memory. Same dispatch either way.
// ---------------------------------------------------------------

export interface GatewayResolvers {
  committedBlock(args: CommittedBlockArgs): Promise<CommittedBlock | null>;
  committedBlocks(args: CommittedBlocksArgs): Promise<CommittedBlock[]>;
  poiCheckpoints(args: PoiCheckpointsArgs): Promise<PoiCheckpoint[]>;
  detectedPatterns(args: DetectedPatternsArgs): Promise<DetectedPattern[]>;
  covenantLineage(args: CovenantLineageArgs): Promise<CovenantLineage | null>;
  entity(args: EntityArgs): Promise<Entity | null>;
  entities(args: EntitiesArgs): Promise<Entity[]>;
  covenantSpends(args: CovenantSpendsArgs): Promise<CovenantSpend[]>;
}

// ---------------------------------------------------------------
// Schema. Kept in one place so introspection and codegen agree.
// ---------------------------------------------------------------

export const KASGRAPH_BASE_SCHEMA_SDL = /* GraphQL */ `
  scalar BigInt
  scalar JSON

  type CommittedBlock {
    subgraph: String!
    blockHash: String!
    daaScore: BigInt!
    servedBy: String!
    committedAt: String!
  }

  type PoiCheckpoint {
    subgraph: String!
    blockDaaScore: BigInt!
    poiHashHex: String!
  }

  type DetectedPattern {
    subgraph: String!
    blockHash: String!
    blockDaaScore: BigInt!
    txHash: String!
    outputIndex: Int!
    detectorKind: String!
    covenantId: String
    payload: JSON
  }

  type CovenantLineageEntry {
    seq: Int!
    txHash: String!
    outputIndex: Int!
    daaScore: BigInt!
    stateBytesHex: String
  }

  type CovenantLineage {
    covenantId: String!
    genesisTx: String!
    currentUtxo: String!
    lineageCount: Int!
    lastSeenDaa: BigInt!
    entries: [CovenantLineageEntry!]!
  }

  "A mapping-emitted entity at its latest committed version."
  type Entity {
    entityType: String!
    entityId: String!
    data: JSON
    blockDaaScore: BigInt!
  }

  "A detected covenant spend (a block input consumed a tracked covenant UTXO)."
  type CovenantSpend {
    spendingTxHash: String!
    previousTxHash: String!
    previousOutputIndex: Int!
    blockDaaScore: BigInt!
    detectorKind: String!
    covenantId: String
    spentValueSompi: BigInt!
    successorCovenantId: String
  }

  type Query {
    committedBlock(subgraph: String!, hash: String!): CommittedBlock
    committedBlocks(subgraph: String!, first: Int = 50): [CommittedBlock!]!
    poiCheckpoints(
      subgraph: String!
      fromDaa: BigInt
      toDaa: BigInt
      first: Int = 50
    ): [PoiCheckpoint!]!
    detectedPatterns(
      subgraph: String!
      kind: String
      first: Int = 50
    ): [DetectedPattern!]!
    covenantLineage(covenantId: String!): CovenantLineage
    "Latest committed state of one entity in a subgraph."
    entity(subgraph: String!, entityType: String!, id: String!): Entity
    "Latest committed state of every entity of a type in a subgraph."
    entities(subgraph: String!, entityType: String!, first: Int = 50): [Entity!]!
    "Detected covenant spends in a subgraph, optionally filtered by covenant id."
    covenantSpends(subgraph: String!, covenantId: String, first: Int = 50): [CovenantSpend!]!
  }

  type Subscription {
    """
    Live stream of detector hits as the indexer commits blocks.
    All three filter args are optional and AND-combined; pass
    none to watch every hit.
    """
    detectedPatterns(
      subgraph: String
      kind: String
      covenantId: String
    ): DetectedPattern!
  }
`;

// BigInt scalar: parsed as a string both ways. Avoids JS
// Number precision loss for DAA scores past 2^53.
const BigIntScalar = new GraphQLScalarType<string, string>({
  name: 'BigInt',
  description:
    'A 64-bit (or larger) unsigned integer, serialized as a decimal string.',
  serialize(value): string {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    throw new GraphQLError(`BigInt cannot serialize value of type ${typeof value}`);
  },
  parseValue(value): string {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    throw new GraphQLError('BigInt must be a string or number on input');
  },
  parseLiteral(ast): string {
    if (ast.kind === Kind.STRING || ast.kind === Kind.INT) {
      return String(ast.value);
    }
    throw new GraphQLError('BigInt literal must be a string or int');
  },
});

// JSON scalar: passes objects through. Used for the detector
// payload which is shape-per-kind.
const JSONScalar = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description: 'Arbitrary JSON value, passed through as-is.',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral(ast): unknown {
    return parseAstLiteral(ast);
  },
});

function parseAstLiteral(ast: import('graphql').ValueNode): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
    case Kind.FLOAT:
      return Number(ast.value);
    case Kind.OBJECT: {
      const obj: Record<string, unknown> = {};
      for (const field of ast.fields) {
        obj[field.name.value] = parseAstLiteral(field.value);
      }
      return obj;
    }
    case Kind.LIST:
      return ast.values.map(parseAstLiteral);
    case Kind.NULL:
      return null;
    default:
      return null;
  }
}

let cachedSchema: GraphQLSchema | null = null;

/**
 * Patch the `BigInt` / `JSON` scalar *implementations* onto a schema that
 * declared them in SDL (`buildSchema` can't see the impls from SDL alone).
 * Shared by the base schema and the per-subgraph schemas.
 */
export function patchKasGraphScalars(schema: GraphQLSchema): void {
  const bigIntType = schema.getType('BigInt');
  if (bigIntType instanceof GraphQLScalarType) {
    Object.assign(bigIntType, {
      serialize: BigIntScalar.serialize,
      parseValue: BigIntScalar.parseValue,
      parseLiteral: BigIntScalar.parseLiteral,
    });
  }
  const jsonType = schema.getType('JSON');
  if (jsonType instanceof GraphQLScalarType) {
    Object.assign(jsonType, {
      serialize: JSONScalar.serialize,
      parseValue: JSONScalar.parseValue,
      parseLiteral: JSONScalar.parseLiteral,
    });
  }
}

/** Returns the executable KasGraph base schema (lazily built once). */
export function getKasGraphSchema(): GraphQLSchema {
  if (cachedSchema !== null) {
    return cachedSchema;
  }
  const schema = buildSchema(KASGRAPH_BASE_SCHEMA_SDL);
  patchKasGraphScalars(schema);
  cachedSchema = schema;
  return schema;
}

// ---------------------------------------------------------------
// Dispatcher. Builds the root-value lookup table from the
// resolvers, validates the query, executes, and returns a
// JSON-serializable result.
// ---------------------------------------------------------------

export interface ExecuteQueryRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface ExecuteQueryResponse {
  data?: ExecutionResult['data'];
  errors?: Array<{ message: string }>;
}

export async function executeGraphQLQuery(
  request: ExecuteQueryRequest,
  resolvers: GatewayResolvers,
): Promise<ExecuteQueryResponse> {
  const schema = getKasGraphSchema();
  let document;
  try {
    document = parse(request.query);
  } catch (err) {
    return {
      errors: [
        { message: err instanceof Error ? err.message : 'parse error' },
      ],
    };
  }
  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return {
      errors: validationErrors.map((e) => ({ message: e.message })),
    };
  }

  const rootValue = {
    committedBlock: (args: CommittedBlockArgs) => resolvers.committedBlock(args),
    committedBlocks: (args: CommittedBlocksArgs) => resolvers.committedBlocks(args),
    poiCheckpoints: (args: PoiCheckpointsArgs) => resolvers.poiCheckpoints(args),
    detectedPatterns: (args: DetectedPatternsArgs) => resolvers.detectedPatterns(args),
    covenantLineage: (args: CovenantLineageArgs) => resolvers.covenantLineage(args),
  };

  const executeOptions: Parameters<typeof execute>[0] = {
    schema,
    document,
    rootValue,
    ...(request.variables !== undefined && { variableValues: request.variables }),
    ...(request.operationName !== undefined && { operationName: request.operationName }),
  };
  const result = await execute(executeOptions);

  const response: ExecuteQueryResponse = {};
  if (result.data !== undefined) {
    response.data = result.data;
  }
  if (result.errors && result.errors.length > 0) {
    response.errors = result.errors.map((e) => ({ message: e.message }));
  }
  return response;
}

/**
 * Attach resolvers for entity-to-entity relation fields on a subgraph schema.
 * A field whose (unwrapped) type is another entity type is a relation:
 *   - `@derivedFrom(field: F)` → a reverse relation; load the target entities
 *     whose payload field `F` equals this entity's `id`.
 *   - otherwise → a direct reference; the payload holds the target id (load it)
 *     or an already-inlined object (return as-is).
 * Scalar fields keep GraphQL's default resolution (read off the payload).
 */
function attachRelationResolvers(
  schema: GraphQLSchema,
  entityNames: Set<string>,
  pool: PgPoolLike,
  subgraphId: string,
): void {
  for (const typeName of entityNames) {
    const type = schema.getType(typeName);
    if (!(type instanceof GraphQLObjectType)) continue;
    for (const [fieldName, field] of Object.entries(type.getFields())) {
      const named = getNamedType(field.type);
      if (!(named instanceof GraphQLObjectType) || !entityNames.has(named.name)) {
        continue; // scalar / non-entity field: default resolution
      }
      const targetType = named.name;
      const derived = (field.astNode?.directives ?? []).find(
        (d) => d.name.value === 'derivedFrom',
      );
      if (derived !== undefined) {
        const arg = (derived.arguments ?? []).find((a) => a.name.value === 'field');
        const refField =
          arg !== undefined && arg.value.kind === Kind.STRING ? arg.value.value : undefined;
        if (refField !== undefined) {
          field.resolve = (source: Record<string, unknown>) =>
            subgraphEntitiesWhere(pool, subgraphId, targetType, refField, String(source['id']));
        }
        continue;
      }
      field.resolve = (source: Record<string, unknown>) => {
        const ref = source?.[fieldName];
        if (ref == null) return null;
        if (typeof ref === 'object') return ref; // already inlined in the payload
        return subgraphEntityById(pool, subgraphId, targetType, String(ref));
      };
    }
  }
}

/**
 * Execute a typed query against a *subgraph's own* schema (generated from its
 * `schema.graphql`). Builds + scalar-patches the schema, wires per-entity
 * resolvers that read the subgraph's `entity_versions` (returning payloads, so
 * GraphQL's default field resolution serves the typed scalar fields), and
 * executes. Schema-build / parse / validation errors come back in `errors`.
 *
 * The subgraph SDL is supplied by the caller; the runtime SDL source (storing
 * each subgraph's `schema.graphql` at deploy time + caching the built schema)
 * is the remaining infra. Relation / `@derivedFrom` fields are present in the
 * schema but resolve only if the entity payload carries them.
 */
export async function executeSubgraphQuery(args: {
  subgraphId: string;
  sdl: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
  pool: PgPoolLike;
}): Promise<ExecuteQueryResponse> {
  let schema: GraphQLSchema;
  try {
    schema = buildSubgraphSchema(args.sdl);
  } catch (err) {
    return {
      errors: [{ message: err instanceof Error ? err.message : 'schema build error' }],
    };
  }
  patchKasGraphScalars(schema);
  const entities = subgraphEntities(args.sdl);
  attachRelationResolvers(
    schema,
    new Set(entities.map((e) => e.name)),
    args.pool,
    args.subgraphId,
  );

  let document;
  try {
    document = parse(args.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const validationErrors = validate(schema, document);
  if (validationErrors.length > 0) {
    return { errors: validationErrors.map((e) => ({ message: e.message })) };
  }

  const rootValue: Record<string, unknown> = {};
  for (const entity of entities) {
    rootValue[entity.queryName] = (a: { id: string }) =>
      subgraphEntityById(args.pool, args.subgraphId, entity.name, a.id);
    rootValue[`${entity.queryName}s`] = (a: { first?: number }) =>
      subgraphEntitiesOfType(args.pool, args.subgraphId, entity.name, a.first);
  }

  const executeOptions: Parameters<typeof execute>[0] = {
    schema,
    document,
    rootValue,
    ...(args.variables !== undefined && { variableValues: args.variables }),
    ...(args.operationName !== undefined && { operationName: args.operationName }),
  };
  const result = await execute(executeOptions);

  const response: ExecuteQueryResponse = {};
  if (result.data !== undefined) {
    response.data = result.data;
  }
  if (result.errors && result.errors.length > 0) {
    response.errors = result.errors.map((e) => ({ message: e.message }));
  }
  return response;
}
