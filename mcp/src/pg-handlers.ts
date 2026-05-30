// Postgres-backed `McpHandlers` impl.
//
// Targets the Phase 2.4 + 2.5 schema in `crates/kasgraph-store/migrations/`.
// Mirrors the `PgGatewayResolvers` pattern in `@kasgraph/api`:
//   - constructed against a `PgPoolLike` so tests mock the pool
//   - each tool maps to a small set of SQL queries
//   - `execute_query` delegates to the GraphQL gateway against the
//     same pool so MCP and GraphQL clients see identical results.
//
// Three tools are deliberately not implemented yet:
//   - get_address_activity
//   - find_subgraphs_for_address
//   - query_natural_language
// They throw `McpHandlerNotImplementedError` with a clear message.
// The first two need an address-indexed view of tx inputs/outputs
// (not in the current schema); the third needs an LLM hook.

import {
  buildSubgraphSchemaSdl,
  executeGraphQLQuery,
  executeSubgraphQuery,
  fetchSubgraphDeployment,
  KASGRAPH_BASE_SCHEMA_SDL,
  PgGatewayResolvers,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '@kasgraph/api';

import type {
  CovenantLineageEntry,
  ExecuteQueryInput,
  ExecuteQueryOutput,
  FindSubgraphsForAddressInput,
  FindSubgraphsForAddressOutput,
  GetAddressActivityInput,
  GetAddressActivityOutput,
  GetCovenantLineageInput,
  GetCovenantLineageOutput,
  GetSchemaInput,
  GetSchemaOutput,
  ListSubgraphsInput,
  ListSubgraphsOutput,
  McpHandlers,
  PatternMatch,
  QueryNaturalLanguageInput,
  QueryNaturalLanguageOutput,
  SearchByPatternInput,
  SearchByPatternOutput,
  SubgraphSummary,
} from './index.js';

export class McpHandlerNotImplementedError extends Error {
  constructor(tool: string, reason: string) {
    super(`MCP tool \`${tool}\` is not implemented yet: ${reason}`);
    this.name = 'McpHandlerNotImplementedError';
  }
}

function bigIntString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

function hexFromBytes(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (typeof value === 'string') return value;
  return '';
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function boundedLimit(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : DEFAULT_LIMIT;
  if (v <= 0) return DEFAULT_LIMIT;
  return v > MAX_LIMIT ? MAX_LIMIT : v;
}

interface SubgraphRow extends QueryResultRow {
  subgraph: string;
  blocks_indexed: unknown;
}

interface DetectedPatternRow extends QueryResultRow {
  tx_hash: string;
  output_index: number;
  block_daa_score: unknown;
  covenant_id: string | null;
}

interface LineageHeadRow extends QueryResultRow {
  covenant_id: string;
  genesis_tx: string;
  current_utxo: string;
  last_seen_daa: unknown;
  lineage_count: number;
}

interface LineageEntryRow extends QueryResultRow {
  seq: number;
  tx_hash: string;
  output_index: number;
  daa_score: unknown;
  state_bytes: unknown;
}

export class PgMcpHandlers implements McpHandlers {
  private readonly gateway: PgGatewayResolvers;

  constructor(private readonly pool: PgPoolLike) {
    this.gateway = new PgGatewayResolvers(pool);
  }

  // -----------------------------------------------------------
  // Backed by Postgres.
  // -----------------------------------------------------------

  async list_subgraphs(input: ListSubgraphsInput): Promise<ListSubgraphsOutput> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    if (input.keyword !== undefined && input.keyword.length > 0) {
      values.push(`%${input.keyword.toLowerCase()}%`);
      clauses.push(`LOWER(subgraph) LIKE $${values.length}`);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = (await this.pool.query<SubgraphRow>(
      `SELECT subgraph, COUNT(*) AS blocks_indexed
       FROM kasgraph_committed_block
       ${whereClause}
       GROUP BY subgraph
       ORDER BY subgraph ASC`,
      values,
    )) as QueryResult<SubgraphRow>;

    return result.rows.map<SubgraphSummary>((row) => {
      const blocks = Number(bigIntString(row.blocks_indexed)) || 0;
      return {
        id: row.subgraph,
        name: row.subgraph,
        blocks_indexed: blocks,
      };
    });
  }

  async get_schema(input: GetSchemaInput): Promise<GetSchemaOutput> {
    // A deployed subgraph publishes its own typed schema (generated from the
    // `schema.graphql` it deployed); anything else gets the canonical KasGraph
    // base/meta schema.
    const deployment = await fetchSubgraphDeployment(this.pool, input.subgraph_id);
    return {
      subgraph_id: input.subgraph_id,
      schema_sdl:
        deployment !== null
          ? buildSubgraphSchemaSdl(deployment.schemaSdl)
          : KASGRAPH_BASE_SCHEMA_SDL,
    };
  }

  async execute_query(input: ExecuteQueryInput): Promise<ExecuteQueryOutput> {
    // Route a known deployed subgraph's query to its own typed schema (its
    // entity types over `"<id>".entity_versions`). For an undeployed id (e.g. a
    // cross-subgraph meta query like `committedBlocks`/`covenantLineage`) fall
    // back to the base gateway, so MCP and GraphQL clients see the same results.
    const deployment = await fetchSubgraphDeployment(this.pool, input.subgraph_id);
    if (deployment !== null) {
      return executeSubgraphQuery({
        subgraphId: input.subgraph_id,
        sdl: deployment.schemaSdl,
        query: input.query,
        ...(input.variables !== undefined && { variables: input.variables }),
        pool: this.pool,
      });
    }
    const request: Parameters<typeof executeGraphQLQuery>[0] = {
      query: input.query,
      ...(input.variables !== undefined && { variables: input.variables }),
    };
    return executeGraphQLQuery(request, this.gateway);
  }

  async search_by_pattern(input: SearchByPatternInput): Promise<SearchByPatternOutput> {
    const limit = boundedLimit(input.limit);
    const result = await this.pool.query<DetectedPatternRow>(
      `SELECT tx_hash, output_index, block_daa_score, covenant_id
       FROM kasgraph_detected_pattern
       WHERE detector_kind = $1
       ORDER BY block_daa_score DESC, tx_hash, output_index
       LIMIT $2`,
      [input.pattern_name, limit],
    );

    return result.rows.map<PatternMatch>((row) => {
      const covenantId = row.covenant_id ?? undefined;
      return {
        tx_hash: row.tx_hash,
        output_index: row.output_index,
        block_daa_score: Number(bigIntString(row.block_daa_score)),
        ...(covenantId !== undefined && { covenant_id: covenantId }),
      };
    });
  }

  async get_covenant_lineage(
    input: GetCovenantLineageInput,
  ): Promise<GetCovenantLineageOutput> {
    const headResult = await this.pool.query<LineageHeadRow>(
      `SELECT covenant_id, genesis_tx, current_utxo, last_seen_daa, lineage_count
       FROM kasgraph_covenant_lineage_head
       WHERE covenant_id = $1
       LIMIT 1`,
      [input.covenant_id],
    );
    const head = headResult.rows[0];
    if (head === undefined) {
      return {
        covenant_id: input.covenant_id,
        lineage: [],
      };
    }

    const rowsResult = await this.pool.query<LineageEntryRow>(
      `SELECT seq, tx_hash, output_index, daa_score, state_bytes
       FROM kasgraph_covenant_lineage_row
       WHERE covenant_id = $1
       ORDER BY seq ASC`,
      [input.covenant_id],
    );

    const lineage: CovenantLineageEntry[] = rowsResult.rows.map((row) => {
      const stateBytesHex = hexFromBytes(row.state_bytes);
      return {
        seq: row.seq,
        tx_hash: row.tx_hash,
        output_index: row.output_index,
        daa_score: Number(bigIntString(row.daa_score)),
        ...(stateBytesHex.length > 0 && { state_bytes_hex: stateBytesHex }),
      };
    });

    return {
      covenant_id: head.covenant_id,
      genesis_tx: head.genesis_tx,
      current_utxo: head.current_utxo,
      lineage,
    };
  }

  // -----------------------------------------------------------
  // Not implemented yet — surface a clear error rather than
  // silently returning empty data.
  // -----------------------------------------------------------

  async get_address_activity(
    _input: GetAddressActivityInput,
  ): Promise<GetAddressActivityOutput> {
    throw new McpHandlerNotImplementedError(
      'get_address_activity',
      'no address-indexed table yet (needs tx input/output parsing during ingestion)',
    );
  }

  async find_subgraphs_for_address(
    _input: FindSubgraphsForAddressInput,
  ): Promise<FindSubgraphsForAddressOutput> {
    throw new McpHandlerNotImplementedError(
      'find_subgraphs_for_address',
      'no address-indexed table yet (needs tx input/output parsing during ingestion)',
    );
  }

  async query_natural_language(
    _input: QueryNaturalLanguageInput,
  ): Promise<QueryNaturalLanguageOutput> {
    throw new McpHandlerNotImplementedError(
      'query_natural_language',
      'no LLM helper wired (needs an external NL→GraphQL service or local model)',
    );
  }
}

// Names that throw `McpHandlerNotImplementedError`. Useful for
// `tools/list` consumers that want to surface a "coming soon"
// hint, and for tests that exercise the not-implemented path.
export const NOT_IMPLEMENTED_TOOLS = [
  'get_address_activity',
  'find_subgraphs_for_address',
  'query_natural_language',
] as const;
