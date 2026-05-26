#!/usr/bin/env node
// kasgraph CLI entry — thin dispatcher over the command surface in
// src/index.ts. Per-command bodies land in Phase 4.

import { parseCommand } from './index.js';

const argv = process.argv.slice(2);
const command = parseCommand(argv);

switch (command) {
  case 'help':
  default:
    process.stdout.write(
      [
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
        'Status: Phase 2 scaffold. Command bodies land in Phase 4.',
        '',
      ].join('\n'),
    );
    break;
}
