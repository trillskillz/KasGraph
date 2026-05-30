// @kasgraph/cli — developer CLI for KasGraph.
//
// Per PLAN.md Phase 4 the command surface is:
//   kasgraph init <name>              scaffold a new subgraph
//   kasgraph init --from-thegraph     migrate from The Graph subgraph
//   kasgraph codegen                  generate types from schema.graphql
//   kasgraph build                    compile mappings to WASM
//   kasgraph deploy --node <url>      deploy to hosted node
//   kasgraph status <subgraph>        indexing status
//   kasgraph logs <subgraph>          tail mapping logs
//   kasgraph remove <subgraph>        remove a deployed subgraph
//   kasgraph mcp-config               generate MCP config for Claude/Cursor/OpenClaw
//
// This module exports a typed dispatch surface and the
// `runCommand` entry that tests + the bin both use. Per-command
// bodies live in sibling files (`init.ts`, `codegen.ts`,
// `build.ts`, `deploy.ts`, `mcp-config.ts`, …). `deploy`/`status`/
// `remove` write/read the store's `kasgraph_subgraph` registry (the
// row the gateway/MCP read to serve a subgraph's typed schema); only
// `logs` remains stubbed pending the hosted-node log stream (Phase 5).

import { runBuild } from './build.js';
import { runCodegen } from './codegen.js';
import { runDeploy, runRemove, runStatus } from './deploy.js';
import { runInit } from './init.js';
import { runMcpConfig } from './mcp-config.js';

// Re-export per-command helpers so tests can exercise them
// without spelunking subpaths.
export { runBuild, type BuildResult } from './build.js';
export { runCodegen, type CodegenResult } from './codegen.js';
export {
  assembleDeployBundle,
  PgSubgraphRegistry,
  resolveDatabaseUrl,
  runDeploy,
  runRemove,
  runStatus,
  subgraphIdFromName,
  type DeployBundle,
  type DeployedStatus,
  type SubgraphRegistryClient,
} from './deploy.js';
export { runInit } from './init.js';
export {
  buildMcpConfig,
  parseMcpConfigArgs,
  runMcpConfig,
  type McpConfigOptions,
} from './mcp-config.js';

export type Command =
  | 'init'
  | 'codegen'
  | 'build'
  | 'deploy'
  | 'status'
  | 'logs'
  | 'remove'
  | 'mcp-config'
  | 'help';

export function parseCommand(argv: string[]): Command {
  const first = argv[0];
  switch (first) {
    case 'init':
    case 'codegen':
    case 'build':
    case 'deploy':
    case 'status':
    case 'logs':
    case 'remove':
    case 'mcp-config':
    case 'help':
      return first;
    default:
      return 'help';
  }
}

/**
 * I/O surface every command works against. Production code wires
 * this to process.stdout/process.stderr/process.cwd(); tests
 * provide capturing buffers and a tmp dir.
 */
export interface CliIo {
  stdout: { write: (s: string) => boolean | void };
  stderr: { write: (s: string) => boolean | void };
  /** Working directory commands resolve relative paths against. */
  cwd: string;
}

export const HELP_TEXT = [
  'kasgraph — subgraph-style indexing for Kaspa',
  '',
  'Commands:',
  '  kasgraph init <name>            Scaffold a new subgraph',
  '  kasgraph init --from-thegraph   Migrate from a The Graph subgraph',
  '  kasgraph codegen                Generate types from schema.graphql',
  '  kasgraph build                  Compile mappings to WASM',
  '  kasgraph deploy --node <url>    Deploy to hosted node',
  '  kasgraph status <subgraph>      Check indexing status',
  '  kasgraph logs <subgraph>        Tail mapping logs',
  '  kasgraph remove <subgraph>      Remove a deployed subgraph',
  '  kasgraph mcp-config             Generate MCP config for Claude/Cursor/OpenClaw',
  '',
].join('\n');

/**
 * Dispatch entry. Returns a process exit code (0 success,
 * non-zero failure). Never throws — every error path returns a
 * numeric code and writes a diagnostic to `io.stderr`.
 */
export async function runCommand(argv: string[], io: CliIo): Promise<number> {
  const command = parseCommand(argv);
  const rest = argv.slice(1);

  switch (command) {
    case 'init':
      return runInit(rest, io);
    case 'mcp-config':
      return runMcpConfig(rest, io);
    case 'codegen':
      return runCodegen(rest, io);
    case 'build':
      return runBuild(rest, io);
    case 'deploy':
      return runDeploy(rest, io);
    case 'status':
      return runStatus(rest, io);
    case 'remove':
      return runRemove(rest, io);
    case 'logs':
      io.stderr.write(
        'kasgraph: `logs` is not implemented yet (needs the hosted-node log stream — Phase 5)\n',
      );
      return 64; // EX_USAGE-ish — recognized but not actionable.
    case 'help':
    default:
      io.stdout.write(HELP_TEXT);
      return 0;
  }
}
