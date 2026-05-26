// @kasgraph/mcp — MCP server scaffold.
//
// PLAN.md Phase 3.2 makes MCP a first-class interface, not a future
// addition. Tools to expose at mcp.kasgraph.io:
//
//   - list_subgraphs(keyword?)             find available subgraphs
//   - get_schema(subgraph_id)              GraphQL schema for NL reasoning
//   - execute_query(subgraph_id, query)    run a GraphQL query
//   - search_by_pattern(pattern_name)      UTXOs matching an OpenSilver pattern
//   - get_covenant_lineage(covenant_id)    KIP-20 lineage walking
//   - get_address_activity(address)        historical activity for any address
//   - find_subgraphs_for_address(address)  which subgraphs index this address
//   - query_natural_language(prompt)       pre-built NL→GraphQL helper
//
// This module exports the typed tool surface so the eventual MCP
// transport (stdio / SSE) can plug in without rewriting the
// definitions.

export interface McpTool {
  /** Tool name as exposed to MCP clients. */
  name: string;
  /** One-line summary surfaced in tool discovery. */
  description: string;
  /** JSONSchema for the tool's input args. */
  inputSchema: Record<string, unknown>;
}

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
