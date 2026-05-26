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
// This module exports the dispatch surface; the per-command bodies
// land in Phase 4 alongside the WASM build pipeline.

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
