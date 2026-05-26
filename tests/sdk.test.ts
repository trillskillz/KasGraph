import { describe, expect, it } from 'vitest';
import {
  KASGRAPH_SDK_VERSION,
  type SubgraphDataSourceKind,
  type SubgraphManifest,
} from '../sdk/src/index.js';
import { KASGRAPH_API_VERSION } from '../api/src/index.js';
import { KASGRAPH_MCP_VERSION, MCP_TOOL_NAMES } from '../mcp/src/index.js';
import { parseCommand } from '../cli/src/index.js';

describe('KasGraph workspace surface — Phase 2 scaffold smoke test', () => {
  it('SDK version is set', () => {
    expect(KASGRAPH_SDK_VERSION).toBe('0.1.0');
  });

  it('all four published versions agree on 0.1.0 at scaffold time', () => {
    expect(KASGRAPH_API_VERSION).toBe(KASGRAPH_SDK_VERSION);
    expect(KASGRAPH_MCP_VERSION).toBe(KASGRAPH_SDK_VERSION);
  });

  it('exposes the canonical MCP tool set from PLAN.md Phase 3.2', () => {
    // Eight tools; matches the PLAN.md "MCP tools exposed" block
    // verbatim. If we add or rename one, this test forces a docs
    // update at the same time.
    expect(MCP_TOOL_NAMES).toEqual([
      'list_subgraphs',
      'get_schema',
      'execute_query',
      'search_by_pattern',
      'get_covenant_lineage',
      'get_address_activity',
      'find_subgraphs_for_address',
      'query_natural_language',
    ]);
  });

  it('CLI command parser recognises every command from PLAN.md Phase 4', () => {
    expect(parseCommand(['init', 'mySubgraph'])).toBe('init');
    expect(parseCommand(['codegen'])).toBe('codegen');
    expect(parseCommand(['build'])).toBe('build');
    expect(parseCommand(['deploy', '--node', 'mainnet'])).toBe('deploy');
    expect(parseCommand(['status', 'mySubgraph'])).toBe('status');
    expect(parseCommand(['logs', 'mySubgraph'])).toBe('logs');
    expect(parseCommand(['remove', 'mySubgraph'])).toBe('remove');
    expect(parseCommand(['mcp-config'])).toBe('mcp-config');
    expect(parseCommand(['help'])).toBe('help');
    expect(parseCommand([])).toBe('help');
    expect(parseCommand(['bogus'])).toBe('help');
  });

  it('manifest type accepts every PLAN.md-documented data-source kind', () => {
    const kinds: SubgraphDataSourceKind[] = [
      'covenant_id',
      'krc20',
      'krc721',
      'address',
      'utxo',
    ];
    // Build a sample manifest matching the PLAN.md kasbonds example.
    const sample: SubgraphManifest = {
      specVersion: '0.1.0',
      name: 'sample',
      schema: { file: './schema.graphql' },
      dataSources: kinds.map((kind) => ({
        name: `${kind}-source`,
        network: 'kaspa-testnet-12',
        kind,
        source: {},
        mapping: {
          kind: 'typescript',
          file: './src/mapping.ts',
          entities: ['Sample'],
          handlers: [],
        },
      })),
    };
    expect(sample.dataSources).toHaveLength(5);
  });
});
