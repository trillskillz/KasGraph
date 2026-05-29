import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  KASGRAPH_SDK_VERSION,
  validateManifest,
  type ManifestIssue,
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

// A structurally complete, canonical manifest used as the baseline for
// the negative cases below — each test mutates one field and asserts the
// validator reports exactly the corresponding issue.
function validManifest(): SubgraphManifest {
  return {
    specVersion: '0.1.0',
    name: 'fixture',
    schema: { file: './schema.graphql' },
    dataSources: [
      {
        name: 'cov',
        network: 'kaspa-mainnet',
        kind: 'covenant_id',
        source: { ids: [{ pattern: 'OpenSilverVault' }] },
        mapping: {
          kind: 'typescript',
          file: './src/mapping.ts',
          entities: ['Vault'],
          handlers: [{ event: 'CovenantLocked', handler: 'handleLocked' }],
        },
      },
    ],
  };
}

function paths(issues: ManifestIssue[]): string[] {
  return issues.map((i) => i.path);
}

describe('validateManifest', () => {
  it('accepts a canonical manifest with no issues', () => {
    expect(validateManifest(validManifest())).toEqual([]);
  });

  it('rejects a non-object manifest', () => {
    expect(validateManifest(null)).toEqual([
      { path: '', message: 'manifest must be an object' },
    ]);
    expect(validateManifest([])).toEqual([
      { path: '', message: 'manifest must be an object' },
    ]);
  });

  it('flags missing top-level required fields by path', () => {
    const issues = validateManifest({});
    expect(paths(issues)).toEqual(
      expect.arrayContaining(['specVersion', 'name', 'schema', 'dataSources']),
    );
  });

  it('requires schema.file to be a non-empty string', () => {
    const m = validManifest();
    (m.schema as { file: unknown }).file = '';
    expect(paths(validateManifest(m))).toContain('schema.file');
  });

  it('requires at least one data source', () => {
    const m = validManifest();
    m.dataSources = [];
    expect(validateManifest(m)).toEqual([
      {
        path: 'dataSources',
        message: 'a manifest must declare at least one data source',
      },
    ]);
  });

  it('rejects an unknown data-source kind', () => {
    const m = validManifest();
    (m.dataSources[0] as { kind: unknown }).kind = 'erc20';
    expect(paths(validateManifest(m))).toContain('dataSources[0].kind');
  });

  it('rejects an unknown network', () => {
    const m = validManifest();
    (m.dataSources[0] as { network: unknown }).network = 'mainnet';
    expect(paths(validateManifest(m))).toContain('dataSources[0].network');
  });

  it('requires mapping.kind to be the literal "typescript"', () => {
    const m = validManifest();
    (m.dataSources[0].mapping as { kind: unknown }).kind = 'wasm';
    expect(paths(validateManifest(m))).toContain('dataSources[0].mapping.kind');
  });

  it('flags non-string entries inside entities and handlers', () => {
    const m = validManifest();
    (m.dataSources[0].mapping.entities as unknown[]) = [42];
    (m.dataSources[0].mapping.handlers as unknown[]) = [{ event: '', handler: 'h' }];
    const ps = paths(validateManifest(m));
    expect(ps).toContain('dataSources[0].mapping.entities[0]');
    expect(ps).toContain('dataSources[0].mapping.handlers[0].event');
  });

  it('rejects a non-numeric startBlock when present', () => {
    const m = validManifest();
    (m.dataSources[0] as { startBlock: unknown }).startBlock = 'soon';
    expect(paths(validateManifest(m))).toContain('dataSources[0].startBlock');
  });

  it('validates every shipped example manifest cleanly', () => {
    const examplesDir = fileURLToPath(new URL('../examples', import.meta.url));
    const dirs = readdirSync(examplesDir, { withFileTypes: true }).filter((e) =>
      e.isDirectory(),
    );
    expect(dirs.length).toBeGreaterThan(0);
    for (const dir of dirs) {
      const yamlPath = path.join(examplesDir, dir.name, 'subgraph.yaml');
      const parsed = parseYaml(readFileSync(yamlPath, 'utf8'));
      const issues = validateManifest(parsed);
      expect(issues, `${dir.name}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });
});
