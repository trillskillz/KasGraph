// @kasgraph/api — GraphQL gateway scaffold.
//
// Per PLAN.md Phase 3.1:
//   - Auto-generate Postgres schema from a subgraph's schema.graphql
//   - Auto-generate resolvers
//   - Auto-handle pagination, filtering, ordering, derived fields
//   - Block-specific queries: `block: { number: 123 }` for historical state
//   - Cross-subgraph federation
//
// This module exports the gateway-config shape consumers feed into
// the server. The actual server (Apollo/Yoga/Mercurius — choice
// deferred to Phase 3.1) lands when the codegen pipeline is ready.

export interface GatewayConfig {
  /** Postgres connection string (multi-tenant; per-subgraph schemas live inside). */
  databaseUrl: string;
  /** Optional federation map: aliases each subgraph id is reachable under. */
  subgraphAliases?: Record<string, string>;
  /** Hosted-service rate limit (queries per minute per API key). */
  rateLimitPerMinute?: number;
}

export const KASGRAPH_API_VERSION = '0.1.0';
