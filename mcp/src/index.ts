// @kasgraph/mcp — MCP server scaffold.
//
// PLAN.md Phase 3.2 makes MCP a first-class interface, not a future
// addition. This module:
//
//   1. Declares the typed MCP tool surface (name, description,
//      JSONSchema, per-tool Input/Output TypeScript types).
//   2. Defines an `McpHandlers` interface so production handlers
//      (Postgres-backed) and test handlers (in-memory) plug into
//      the same dispatch.
//   3. Exports `dispatchMcpTool(name, args, handlers)` for the
//      eventual stdio / SSE transport to call.
//
// The actual MCP transport (`@modelcontextprotocol/sdk`) is wired
// in a separate slice once the handler surface is stable; keeping
// it out of this file means `tsc --noEmit` typechecks the whole
// surface with zero runtime deps.

// ---------------------------------------------------------------
// Tool-name registry (stable for docs / regression tests).
// ---------------------------------------------------------------

export const MCP_TOOL_NAMES = [
  'list_subgraphs',
  'get_schema',
  'execute_query',
  'search_by_pattern',
  'get_covenant_lineage',
  'get_address_activity',
  'find_subgraphs_for_address',
  'query_natural_language',
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

export const KASGRAPH_MCP_VERSION = '0.1.0';

// Postgres-backed handler impl (Phase 2.4 + 2.5 schema).
export {
  PgMcpHandlers,
  McpHandlerNotImplementedError,
  NOT_IMPLEMENTED_TOOLS,
} from './pg-handlers.js';

// MCP server scaffolding (stdio transport).
export {
  callToolToContent,
  createKasGraphMcpServer,
  runMcpStdioServer,
  type McpToolCallContent,
} from './server.js';

// Operator binary entry — re-exported so tests can exercise the
// env reader without spawning the binary.
export { readOptionsFromEnv, runKasGraphMcpServer } from './main.js';
export type { RunMcpOptions, RunningMcpServer } from './main.js';

// ---------------------------------------------------------------
// Tool definitions (name + description + JSONSchema for inputs).
// ---------------------------------------------------------------

export interface McpTool {
  /** Tool name as exposed to MCP clients. */
  name: McpToolName;
  /** One-line summary surfaced in tool discovery. */
  description: string;
  /** JSONSchema for the tool's input args. */
  inputSchema: Record<string, unknown>;
}

/**
 * Canonical MCP tool surface. Bundled into `mcpToolListing()` for
 * `tools/list`-style discovery requests.
 */
export const MCP_TOOLS: Record<McpToolName, McpTool> = {
  list_subgraphs: {
    name: 'list_subgraphs',
    description:
      'List available KasGraph subgraphs, optionally filtered by a keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description:
            'Optional substring matched against subgraph name and description.',
        },
      },
      additionalProperties: false,
    },
  },
  get_schema: {
    name: 'get_schema',
    description:
      'Return the GraphQL schema for a subgraph so an LLM can reason about its entities.',
    inputSchema: {
      type: 'object',
      properties: {
        subgraph_id: { type: 'string' },
      },
      required: ['subgraph_id'],
      additionalProperties: false,
    },
  },
  execute_query: {
    name: 'execute_query',
    description:
      'Execute a GraphQL query against the named subgraph and return the result JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        subgraph_id: { type: 'string' },
        query: { type: 'string' },
        variables: { type: 'object', additionalProperties: true },
      },
      required: ['subgraph_id', 'query'],
      additionalProperties: false,
    },
  },
  search_by_pattern: {
    name: 'search_by_pattern',
    description:
      'Find UTXOs matching an OpenSilver detector pattern (e.g. OpenSilverVault).',
    inputSchema: {
      type: 'object',
      properties: {
        pattern_name: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      required: ['pattern_name'],
      additionalProperties: false,
    },
  },
  get_covenant_lineage: {
    name: 'get_covenant_lineage',
    description:
      'Walk the KIP-20 lineage for a covenant id from genesis to the current UTXO.',
    inputSchema: {
      type: 'object',
      properties: {
        covenant_id: { type: 'string' },
      },
      required: ['covenant_id'],
      additionalProperties: false,
    },
  },
  get_address_activity: {
    name: 'get_address_activity',
    description:
      'Recent indexer activity for any Kaspa address (sends, receives, covenant interactions).',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  find_subgraphs_for_address: {
    name: 'find_subgraphs_for_address',
    description: 'Which subgraphs index events involving this address?',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
      },
      required: ['address'],
      additionalProperties: false,
    },
  },
  query_natural_language: {
    name: 'query_natural_language',
    description:
      'Pre-built natural-language → GraphQL helper. Returns the generated query plus the result.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        subgraph_id: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
};

/** Returns the tool listing in stable order for MCP `tools/list`. */
export function mcpToolListing(): McpTool[] {
  return MCP_TOOL_NAMES.map((name) => MCP_TOOLS[name]);
}

// ---------------------------------------------------------------
// Per-tool input + output types. Outputs are TypeScript types;
// inputs additionally have JSONSchema (see MCP_TOOLS above) for
// runtime validation by the transport layer.
// ---------------------------------------------------------------

export interface ListSubgraphsInput {
  keyword?: string;
}
export interface SubgraphSummary {
  id: string;
  name: string;
  description?: string;
  blocks_indexed: number;
}
export type ListSubgraphsOutput = SubgraphSummary[];

export interface GetSchemaInput {
  subgraph_id: string;
}
export interface GetSchemaOutput {
  subgraph_id: string;
  schema_sdl: string;
}

export interface ExecuteQueryInput {
  subgraph_id: string;
  query: string;
  variables?: Record<string, unknown>;
}
export interface ExecuteQueryOutput {
  data?: unknown;
  errors?: Array<{ message: string }>;
}

export interface SearchByPatternInput {
  pattern_name: string;
  limit?: number;
}
export interface PatternMatch {
  tx_hash: string;
  output_index: number;
  block_daa_score: number;
  covenant_id?: string;
}
export type SearchByPatternOutput = PatternMatch[];

export interface GetCovenantLineageInput {
  covenant_id: string;
}
export interface CovenantLineageEntry {
  seq: number;
  tx_hash: string;
  output_index: number;
  daa_score: number;
  /** Hex-encoded redeem-script state bytes spliced into this transition. */
  state_bytes_hex?: string;
}
export interface GetCovenantLineageOutput {
  covenant_id: string;
  genesis_tx?: string;
  current_utxo?: string;
  lineage: CovenantLineageEntry[];
}

export interface GetAddressActivityInput {
  address: string;
  limit?: number;
}
export interface AddressActivityEntry {
  daa_score: number;
  tx_hash: string;
  /** e.g. `"send"` / `"receive"` / `"covenant_signer"` */
  kind: string;
  /** Counterparty address when known. */
  counterparty?: string;
  amount_sompi?: string;
}
export type GetAddressActivityOutput = AddressActivityEntry[];

export interface FindSubgraphsForAddressInput {
  address: string;
}
export type FindSubgraphsForAddressOutput = SubgraphSummary[];

export interface QueryNaturalLanguageInput {
  prompt: string;
  subgraph_id?: string;
}
export interface QueryNaturalLanguageOutput {
  /** GraphQL the helper generated for the prompt. */
  generated_query: string;
  /** Result of executing `generated_query`. */
  result: ExecuteQueryOutput;
}

// ---------------------------------------------------------------
// Handler contract — production impl (Postgres-backed) and the
// in-memory test impl both implement this.
// ---------------------------------------------------------------

export interface McpHandlers {
  list_subgraphs(input: ListSubgraphsInput): Promise<ListSubgraphsOutput>;
  get_schema(input: GetSchemaInput): Promise<GetSchemaOutput>;
  execute_query(input: ExecuteQueryInput): Promise<ExecuteQueryOutput>;
  search_by_pattern(input: SearchByPatternInput): Promise<SearchByPatternOutput>;
  get_covenant_lineage(
    input: GetCovenantLineageInput,
  ): Promise<GetCovenantLineageOutput>;
  get_address_activity(
    input: GetAddressActivityInput,
  ): Promise<GetAddressActivityOutput>;
  find_subgraphs_for_address(
    input: FindSubgraphsForAddressInput,
  ): Promise<FindSubgraphsForAddressOutput>;
  query_natural_language(
    input: QueryNaturalLanguageInput,
  ): Promise<QueryNaturalLanguageOutput>;
}

// ---------------------------------------------------------------
// Dispatch. The transport layer (stdio / SSE) calls this with the
// raw `args` it received from the client. Runtime input validation
// is intentionally minimal here — the transport already validates
// against `inputSchema` before calling us. We re-check the
// required keys so a misbehaving transport can't crash a handler.
// ---------------------------------------------------------------

export type McpDispatchErrorCode = 'unknown_tool' | 'invalid_input';

export class McpDispatchError extends Error {
  constructor(
    public readonly code: McpDispatchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'McpDispatchError';
  }
}

function ensureObject(
  args: unknown,
  tool: string,
): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new McpDispatchError(
      'invalid_input',
      `${tool}: args must be a JSON object`,
    );
  }
  return args as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  tool: string,
): string {
  const v = obj[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new McpDispatchError(
      'invalid_input',
      `${tool}: missing or empty string field \`${key}\``,
    );
  }
  return v;
}

function optionalString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = obj[key];
  return typeof v === 'string' ? v : undefined;
}

function optionalNumber(
  obj: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = obj[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function optionalRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

/**
 * Type-safe dispatch. Returns whatever the matching handler returns.
 * Throws `McpDispatchError` for an unknown tool name or malformed
 * input shape.
 */
export async function dispatchMcpTool(
  name: string,
  args: unknown,
  handlers: McpHandlers,
): Promise<unknown> {
  switch (name) {
    // Inputs are built with conditional spread so optional fields
    // are omitted (not set to `undefined`) — keeps
    // exactOptionalPropertyTypes happy.
    case 'list_subgraphs': {
      const obj = ensureObject(args, name);
      const keyword = optionalString(obj, 'keyword');
      return handlers.list_subgraphs({ ...(keyword !== undefined && { keyword }) });
    }
    case 'get_schema': {
      const obj = ensureObject(args, name);
      return handlers.get_schema({
        subgraph_id: requireString(obj, 'subgraph_id', name),
      });
    }
    case 'execute_query': {
      const obj = ensureObject(args, name);
      const variables = optionalRecord(obj, 'variables');
      return handlers.execute_query({
        subgraph_id: requireString(obj, 'subgraph_id', name),
        query: requireString(obj, 'query', name),
        ...(variables !== undefined && { variables }),
      });
    }
    case 'search_by_pattern': {
      const obj = ensureObject(args, name);
      const limit = optionalNumber(obj, 'limit');
      return handlers.search_by_pattern({
        pattern_name: requireString(obj, 'pattern_name', name),
        ...(limit !== undefined && { limit }),
      });
    }
    case 'get_covenant_lineage': {
      const obj = ensureObject(args, name);
      return handlers.get_covenant_lineage({
        covenant_id: requireString(obj, 'covenant_id', name),
      });
    }
    case 'get_address_activity': {
      const obj = ensureObject(args, name);
      const limit = optionalNumber(obj, 'limit');
      return handlers.get_address_activity({
        address: requireString(obj, 'address', name),
        ...(limit !== undefined && { limit }),
      });
    }
    case 'find_subgraphs_for_address': {
      const obj = ensureObject(args, name);
      return handlers.find_subgraphs_for_address({
        address: requireString(obj, 'address', name),
      });
    }
    case 'query_natural_language': {
      const obj = ensureObject(args, name);
      const subgraph_id = optionalString(obj, 'subgraph_id');
      return handlers.query_natural_language({
        prompt: requireString(obj, 'prompt', name),
        ...(subgraph_id !== undefined && { subgraph_id }),
      });
    }
    default:
      throw new McpDispatchError('unknown_tool', `unknown MCP tool: ${name}`);
  }
}
