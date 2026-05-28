// MCP server scaffolding.
//
// Builds a `@modelcontextprotocol/sdk` Server instance, registers
// the canonical KasGraph tool surface (`mcpToolListing`), and
// routes `tools/call` requests through `dispatchMcpTool` against
// the supplied `McpHandlers`.
//
// Transport is decoupled — `runMcpStdioServer` wires stdio for
// the operator binary, but the same `createKasGraphMcpServer`
// can be paired with `SSEServerTransport` or a custom transport
// for hosted deployments.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  dispatchMcpTool,
  KASGRAPH_MCP_VERSION,
  McpDispatchError,
  mcpToolListing,
  type McpHandlers,
} from './index.js';

/**
 * Build a configured MCP `Server` with the KasGraph tool surface
 * routed through `handlers`. Caller picks a transport and calls
 * `server.connect(transport)`.
 */
export function createKasGraphMcpServer(handlers: McpHandlers): Server {
  const server = new Server(
    {
      name: 'kasgraph',
      version: KASGRAPH_MCP_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // tools/list — stable order from the canonical registry so
  // discovery results are reproducible across restarts.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: mcpToolListing(),
    };
  });

  // tools/call — every tool routes through dispatchMcpTool so
  // input validation + handler routing stay identical to the
  // in-process path.
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const content = await callToolToContent(name, args ?? {}, handlers);
    // The SDK's ServerResult union for tools/call is a discriminated
    // record-with-content shape; our narrower `McpToolCallContent`
    // type is a subset that satisfies it at runtime, but the
    // declared union includes extra alternatives (e.g. the `task`
    // variant for long-running tools). Cast through `unknown` so
    // the SDK accepts the content-only response without us having
    // to discriminate explicitly here.
    return content as unknown as Awaited<
      ReturnType<Parameters<typeof server.setRequestHandler<typeof CallToolRequestSchema>>[1]>
    >;
  });

  return server;
}

/**
 * Shape of an MCP `tools/call` response. Wraps a single text
 * content block whose body is a JSON encoding of either the
 * handler's result or a structured error object.
 */
export interface McpToolCallContent {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Pure helper used by the `tools/call` request handler.
 * Factored out so vitest can exercise the dispatch + content
 * shaping without standing up a real MCP transport.
 */
export async function callToolToContent(
  name: string,
  args: unknown,
  handlers: McpHandlers,
): Promise<McpToolCallContent> {
  try {
    const result = await dispatchMcpTool(name, args, handlers);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    const isDispatchError = err instanceof McpDispatchError;
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: message,
            code: isDispatchError ? err.code : 'handler_error',
          }),
        },
      ],
    };
  }
}

/**
 * Convenience wrapper for the operator binary: builds the server
 * and connects it to a stdio transport. Returns the (server,
 * transport) pair so callers can `close()` them on shutdown.
 */
export async function runMcpStdioServer(
  handlers: McpHandlers,
): Promise<{ server: Server; transport: StdioServerTransport }> {
  const server = createKasGraphMcpServer(handlers);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}
