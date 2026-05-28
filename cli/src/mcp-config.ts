// `kasgraph mcp-config` — emit an MCP client config snippet that
// wires the `kasgraph-mcp` binary over stdio.
//
// The output matches Claude Desktop's `mcpServers` block; the
// same shape is consumed by Cursor and OpenClaw. Operators paste
// the printed JSON into ~/.claude/claude_desktop_config.json (or
// the equivalent for their client).
//
// Flags:
//   --database-url <url>   value placed under env.DATABASE_URL
//                          (defaults to the literal "postgres://USER:PASS@HOST/DB"
//                          so operators see exactly which field to edit)
//   --command <bin>        executable to spawn (default: `kasgraph-mcp`)
//   --server-name <name>   key under `mcpServers` (default: `kasgraph`)

import type { CliIo } from './index.js';

export interface McpConfigOptions {
  databaseUrl: string;
  command: string;
  serverName: string;
}

const DEFAULT_DATABASE_URL = 'postgres://USER:PASS@HOST/DB';

export function parseMcpConfigArgs(args: string[]): McpConfigOptions {
  let databaseUrl = DEFAULT_DATABASE_URL;
  let command = 'kasgraph-mcp';
  let serverName = 'kasgraph';

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--database-url':
      case '--db':
        databaseUrl = requireValue(args, i, a);
        i++;
        break;
      case '--command':
      case '--bin':
        command = requireValue(args, i, a);
        i++;
        break;
      case '--server-name':
      case '--name':
        serverName = requireValue(args, i, a);
        i++;
        break;
      default:
        throw new Error(`kasgraph mcp-config: unknown argument \`${a}\``);
    }
  }

  return { databaseUrl, command, serverName };
}

function requireValue(args: string[], i: number, flag: string): string {
  const v = args[i + 1];
  if (v === undefined) {
    throw new Error(`kasgraph mcp-config: ${flag} requires a value`);
  }
  return v;
}

/**
 * Build the JSON object exactly matching Claude Desktop's
 * `mcpServers` shape. Exposed so other tooling (an "install for
 * Cursor" command, for instance) can reuse the structure.
 */
export function buildMcpConfig(options: McpConfigOptions): Record<string, unknown> {
  return {
    mcpServers: {
      [options.serverName]: {
        command: options.command,
        args: [],
        env: {
          DATABASE_URL: options.databaseUrl,
        },
      },
    },
  };
}

export function runMcpConfig(args: string[], io: CliIo): number {
  let options: McpConfigOptions;
  try {
    options = parseMcpConfigArgs(args);
  } catch (err) {
    io.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 64; // EX_USAGE
  }

  const config = buildMcpConfig(options);
  io.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  return 0;
}
