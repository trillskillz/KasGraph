// HTTP transport for the KasGraph GraphQL gateway.
//
// Wraps the executable schema (built once via `getKasGraphSchema`)
// in a Yoga handler. The handler is a Fetch-API-compliant
// `(request) => Response` function — it slots into Node's
// built-in `http`, into Fastify/Express adapters, into the
// Workers/Deno fetch model, or into our own tests via
// `yoga.fetch(new Request(...))` without binding a socket.
//
// PLAN.md Phase 3.1 calls out Yoga as the recommended default;
// `@kasgraph/api` stays framework-agnostic at the `executeGraphQLQuery`
// layer, and only this module pulls Yoga in.

import { createSchema, createYoga } from 'graphql-yoga';

import {
  KASGRAPH_BASE_SCHEMA_SDL,
  type GatewayResolvers,
} from './index.js';
import { PgGatewayResolvers, type PgPoolLike } from './pg-resolvers.js';
import type { SubscriptionSource } from './subscriptions.js';

/** The handler `createKasGraphServer` returns. */
export type KasGraphServer = ReturnType<typeof createYoga>;

export interface KasGraphServerOptions {
  /**
   * Postgres pool. Connection management (acquire, retire,
   * shutdown) is the caller's responsibility.
   */
  pool: PgPoolLike;
  /**
   * Override the resolvers used by the schema. Defaults to
   * `new PgGatewayResolvers(pool)`. Tests pass in-memory
   * resolvers; production code can compose middleware (caching,
   * rate-limiting, multi-region routing) around the pg impl.
   */
  resolvers?: GatewayResolvers;
  /**
   * Event source for `Subscription.detectedPatterns`. When
   * `undefined`, the field rejects every subscribe with a
   * "subscriptions not configured" error so clients see a
   * clear cause rather than a silent hang.
   */
  subscriptionSource?: SubscriptionSource;
  /** GraphQL endpoint path. Defaults to `/graphql`. */
  graphqlEndpoint?: string;
  /**
   * Toggle GraphiQL on the GET endpoint. Defaults to `true` in
   * development — operators flip this off in production via
   * `KASGRAPH_GRAPHIQL=false` or by passing `graphiql: false`.
   */
  graphiql?: boolean;
}

/**
 * Build a Yoga handler that serves the canonical KasGraph schema
 * against the supplied resolvers. The returned value is the
 * standard Yoga server instance, callable as both a Fetch
 * `(Request) => Response` function and a Node-http `(req, res)`
 * handler.
 */
export function createKasGraphServer(
  options: KasGraphServerOptions,
): KasGraphServer {
  const resolvers: GatewayResolvers =
    options.resolvers ?? new PgGatewayResolvers(options.pool);
  const subscriptionSource = options.subscriptionSource;

  // Build schema via Yoga's `createSchema` (under the hood
  // `@graphql-tools/schema.makeExecutableSchema`). Using field
  // resolvers — instead of the rootValue path
  // `executeGraphQLQuery` uses for the in-process executor —
  // lets us attach a `Subscription.detectedPatterns.subscribe`
  // resolver, which the rootValue model cannot express.
  const schema = createSchema({
    typeDefs: KASGRAPH_BASE_SCHEMA_SDL,
    resolvers: {
      Query: {
        committedBlock: (_root, args) =>
          resolvers.committedBlock(args as Parameters<GatewayResolvers['committedBlock']>[0]),
        committedBlocks: (_root, args) =>
          resolvers.committedBlocks(args as Parameters<GatewayResolvers['committedBlocks']>[0]),
        poiCheckpoints: (_root, args) =>
          resolvers.poiCheckpoints(args as Parameters<GatewayResolvers['poiCheckpoints']>[0]),
        detectedPatterns: (_root, args) =>
          resolvers.detectedPatterns(
            args as Parameters<GatewayResolvers['detectedPatterns']>[0],
          ),
        covenantLineage: (_root, args) =>
          resolvers.covenantLineage(
            args as Parameters<GatewayResolvers['covenantLineage']>[0],
          ),
        entity: (_root, args) =>
          resolvers.entity(args as Parameters<GatewayResolvers['entity']>[0]),
        entities: (_root, args) =>
          resolvers.entities(args as Parameters<GatewayResolvers['entities']>[0]),
        covenantSpends: (_root, args) =>
          resolvers.covenantSpends(
            args as Parameters<GatewayResolvers['covenantSpends']>[0],
          ),
      },
      Subscription: {
        detectedPatterns: {
          subscribe: (
            _root: unknown,
            args: { subgraph?: string; kind?: string; covenantId?: string },
          ) => {
            if (subscriptionSource === undefined) {
              throw new Error(
                'kasgraph-api: subscriptions are not configured on this gateway (pass `subscriptionSource` to createKasGraphServer)',
              );
            }
            // Conditional spread keeps undefined fields off the
            // filter object so `exactOptionalPropertyTypes: true`
            // downstream stays happy.
            const filter: { subgraph?: string; kind?: string; covenantId?: string } = {
              ...(args.subgraph !== undefined && { subgraph: args.subgraph }),
              ...(args.kind !== undefined && { kind: args.kind }),
              ...(args.covenantId !== undefined && { covenantId: args.covenantId }),
            };
            return subscriptionSource.subscribeDetectedPatterns(filter);
          },
          resolve: (payload: unknown) => payload,
        },
      },
    },
  });

  return createYoga({
    schema,
    graphqlEndpoint: options.graphqlEndpoint ?? '/graphql',
    graphiql: options.graphiql ?? true,
    landingPage: false,
    // Don't auto-mask errors — return their original message so
    // the consumer can see schema/parsing problems clearly.
    // Production deployments override this from the wrapper layer.
    maskedErrors: false,
  });
}
