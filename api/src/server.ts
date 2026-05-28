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

import { createYoga, type Plugin } from 'graphql-yoga';

import {
  getKasGraphSchema,
  type GatewayResolvers,
} from './index.js';
import { PgGatewayResolvers, type PgPoolLike } from './pg-resolvers.js';

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
  const schema = getKasGraphSchema();

  // Same `rootValue` shape `executeGraphQLQuery` builds — every
  // top-level Query field looks up here. Keeping it in one place
  // means the in-process executor and the HTTP server cannot
  // drift.
  const rootValue = {
    committedBlock: resolvers.committedBlock.bind(resolvers),
    committedBlocks: resolvers.committedBlocks.bind(resolvers),
    poiCheckpoints: resolvers.poiCheckpoints.bind(resolvers),
    detectedPatterns: resolvers.detectedPatterns.bind(resolvers),
    covenantLineage: resolvers.covenantLineage.bind(resolvers),
  };

  // Inject our rootValue at request-execute time. Yoga's
  // `createYoga` doesn't accept rootValue directly the way
  // `execute` does — the cleanest hook is the `onExecute`
  // plugin event. The plugin type is intentionally widened
  // to `Plugin` (no context generic) to keep
  // exactOptionalPropertyTypes from forcing a complete
  // inferred-context shape on every caller.
  const injectRootValue: Plugin = {
    onExecute({ args }) {
      (args as unknown as { rootValue: unknown }).rootValue = rootValue;
    },
  };

  return createYoga({
    schema,
    plugins: [injectRootValue],
    graphqlEndpoint: options.graphqlEndpoint ?? '/graphql',
    graphiql: options.graphiql ?? true,
    landingPage: false,
    // Don't auto-mask errors — return their original message so
    // the consumer can see schema/parsing problems clearly.
    // Production deployments override this from the wrapper layer.
    maskedErrors: false,
  });
}
