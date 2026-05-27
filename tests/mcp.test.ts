import { describe, expect, it } from 'vitest';
import {
  dispatchMcpTool,
  McpDispatchError,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  mcpToolListing,
  type AddressActivityEntry,
  type CovenantLineageEntry,
  type ExecuteQueryInput,
  type ExecuteQueryOutput,
  type FindSubgraphsForAddressInput,
  type FindSubgraphsForAddressOutput,
  type GetAddressActivityInput,
  type GetAddressActivityOutput,
  type GetCovenantLineageInput,
  type GetCovenantLineageOutput,
  type GetSchemaInput,
  type GetSchemaOutput,
  type ListSubgraphsInput,
  type ListSubgraphsOutput,
  type McpHandlers,
  type PatternMatch,
  type QueryNaturalLanguageInput,
  type QueryNaturalLanguageOutput,
  type SearchByPatternInput,
  type SearchByPatternOutput,
  type SubgraphSummary,
} from '../mcp/src/index.js';

// In-memory handlers used by the dispatch tests. Mirrors the
// production handler contract; the seed data is intentionally
// small.
class InMemoryHandlers implements McpHandlers {
  readonly calls: Array<{ tool: string; args: unknown }> = [];

  private readonly subgraphs: SubgraphSummary[] = [
    {
      id: 'kasbonds',
      name: 'KasBonds',
      description: 'Index all KasBonds activity.',
      blocks_indexed: 12345,
    },
    {
      id: 'opensilver_patterns',
      name: 'OpenSilver Patterns',
      description: 'UTXOs matching OpenSilver covenant patterns.',
      blocks_indexed: 67890,
    },
  ];

  private readonly addressSubgraphMap: Record<string, string[]> = {
    'kaspa:alice': ['kasbonds', 'opensilver_patterns'],
    'kaspa:bob': ['opensilver_patterns'],
  };

  async list_subgraphs(input: ListSubgraphsInput): Promise<ListSubgraphsOutput> {
    this.calls.push({ tool: 'list_subgraphs', args: input });
    if (input.keyword === undefined) {
      return this.subgraphs;
    }
    const k = input.keyword.toLowerCase();
    return this.subgraphs.filter(
      (s) =>
        s.name.toLowerCase().includes(k) || (s.description ?? '').toLowerCase().includes(k),
    );
  }

  async get_schema(input: GetSchemaInput): Promise<GetSchemaOutput> {
    this.calls.push({ tool: 'get_schema', args: input });
    return {
      subgraph_id: input.subgraph_id,
      schema_sdl: `type Bond { id: ID! issuer: String! }`,
    };
  }

  async execute_query(input: ExecuteQueryInput): Promise<ExecuteQueryOutput> {
    this.calls.push({ tool: 'execute_query', args: input });
    return { data: { ok: true, subgraph: input.subgraph_id } };
  }

  async search_by_pattern(input: SearchByPatternInput): Promise<SearchByPatternOutput> {
    this.calls.push({ tool: 'search_by_pattern', args: input });
    const sample: PatternMatch[] = [
      { tx_hash: 'tx-1', output_index: 0, block_daa_score: 100, covenant_id: '0xabc' },
      { tx_hash: 'tx-2', output_index: 1, block_daa_score: 101 },
    ];
    return sample.slice(0, input.limit ?? sample.length);
  }

  async get_covenant_lineage(
    input: GetCovenantLineageInput,
  ): Promise<GetCovenantLineageOutput> {
    this.calls.push({ tool: 'get_covenant_lineage', args: input });
    const lineage: CovenantLineageEntry[] = [
      { seq: 0, tx_hash: 'genesis', output_index: 0, daa_score: 10 },
      { seq: 1, tx_hash: 'spend1', output_index: 0, daa_score: 11 },
    ];
    return {
      covenant_id: input.covenant_id,
      genesis_tx: 'genesis',
      current_utxo: 'spend1:0',
      lineage,
    };
  }

  async get_address_activity(
    input: GetAddressActivityInput,
  ): Promise<GetAddressActivityOutput> {
    this.calls.push({ tool: 'get_address_activity', args: input });
    const sample: AddressActivityEntry[] = [
      { daa_score: 100, tx_hash: 'a', kind: 'send', counterparty: 'kaspa:bob' },
      { daa_score: 101, tx_hash: 'b', kind: 'receive', counterparty: 'kaspa:bob' },
      { daa_score: 102, tx_hash: 'c', kind: 'covenant_signer' },
    ];
    return sample.slice(0, input.limit ?? sample.length);
  }

  async find_subgraphs_for_address(
    input: FindSubgraphsForAddressInput,
  ): Promise<FindSubgraphsForAddressOutput> {
    this.calls.push({ tool: 'find_subgraphs_for_address', args: input });
    const ids = this.addressSubgraphMap[input.address] ?? [];
    return this.subgraphs.filter((s) => ids.includes(s.id));
  }

  async query_natural_language(
    input: QueryNaturalLanguageInput,
  ): Promise<QueryNaturalLanguageOutput> {
    this.calls.push({ tool: 'query_natural_language', args: input });
    const generated_query = `# generated for: ${input.prompt}\n{ bonds(first:1) { id } }`;
    return {
      generated_query,
      result: { data: { bonds: [{ id: 'b1' }] } },
    };
  }
}

describe('@kasgraph/mcp — tool registry', () => {
  it('exports a definition for every name in MCP_TOOL_NAMES', () => {
    for (const name of MCP_TOOL_NAMES) {
      expect(MCP_TOOLS[name]).toBeDefined();
      expect(MCP_TOOLS[name].name).toBe(name);
      expect(typeof MCP_TOOLS[name].description).toBe('string');
      expect(MCP_TOOLS[name].inputSchema).toBeDefined();
    }
  });

  it('mcpToolListing returns tools in canonical order', () => {
    const listing = mcpToolListing();
    expect(listing.map((t) => t.name)).toEqual([...MCP_TOOL_NAMES]);
  });

  it('every inputSchema declares additionalProperties:false', () => {
    for (const tool of mcpToolListing()) {
      expect(tool.inputSchema).toMatchObject({ additionalProperties: false });
    }
  });
});

describe('@kasgraph/mcp — dispatch', () => {
  it('rejects an unknown tool name', async () => {
    const handlers = new InMemoryHandlers();
    await expect(dispatchMcpTool('not_a_tool', {}, handlers)).rejects.toBeInstanceOf(
      McpDispatchError,
    );
  });

  it('rejects non-object args', async () => {
    const handlers = new InMemoryHandlers();
    await expect(
      dispatchMcpTool('list_subgraphs', 'not-an-object', handlers),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects missing required fields', async () => {
    const handlers = new InMemoryHandlers();
    await expect(dispatchMcpTool('get_schema', {}, handlers)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      dispatchMcpTool('execute_query', { subgraph_id: 'x' }, handlers),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('list_subgraphs routes with optional keyword', async () => {
    const handlers = new InMemoryHandlers();
    const all = (await dispatchMcpTool('list_subgraphs', {}, handlers)) as ListSubgraphsOutput;
    expect(all).toHaveLength(2);
    const filtered = (await dispatchMcpTool(
      'list_subgraphs',
      { keyword: 'kasbonds' },
      handlers,
    )) as ListSubgraphsOutput;
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.id).toBe('kasbonds');
  });

  it('get_schema returns SDL for the requested subgraph', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'get_schema',
      { subgraph_id: 'kasbonds' },
      handlers,
    )) as GetSchemaOutput;
    expect(got.subgraph_id).toBe('kasbonds');
    expect(got.schema_sdl).toContain('type Bond');
  });

  it('execute_query forwards variables when present', async () => {
    const handlers = new InMemoryHandlers();
    await dispatchMcpTool(
      'execute_query',
      { subgraph_id: 'kasbonds', query: '{ bonds }', variables: { first: 1 } },
      handlers,
    );
    expect(handlers.calls.at(-1)?.args).toMatchObject({
      subgraph_id: 'kasbonds',
      query: '{ bonds }',
      variables: { first: 1 },
    });
  });

  it('execute_query omits variables when not supplied (exactOptionalPropertyTypes)', async () => {
    const handlers = new InMemoryHandlers();
    await dispatchMcpTool(
      'execute_query',
      { subgraph_id: 'kasbonds', query: '{ bonds }' },
      handlers,
    );
    const lastArgs = handlers.calls.at(-1)?.args as Record<string, unknown>;
    expect('variables' in lastArgs).toBe(false);
  });

  it('search_by_pattern honors the limit field', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'search_by_pattern',
      { pattern_name: 'OpenSilverVault', limit: 1 },
      handlers,
    )) as SearchByPatternOutput;
    expect(got).toHaveLength(1);
  });

  it('get_covenant_lineage returns lineage walking output', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'get_covenant_lineage',
      { covenant_id: '0xabc' },
      handlers,
    )) as GetCovenantLineageOutput;
    expect(got.covenant_id).toBe('0xabc');
    expect(got.lineage.length).toBeGreaterThan(0);
    expect(got.lineage[0]!.seq).toBe(0);
  });

  it('get_address_activity returns recent entries', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'get_address_activity',
      { address: 'kaspa:alice' },
      handlers,
    )) as GetAddressActivityOutput;
    expect(got.length).toBeGreaterThan(0);
  });

  it('find_subgraphs_for_address filters by indexed-address mapping', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'find_subgraphs_for_address',
      { address: 'kaspa:alice' },
      handlers,
    )) as FindSubgraphsForAddressOutput;
    expect(got.map((s) => s.id)).toEqual(['kasbonds', 'opensilver_patterns']);

    const empty = (await dispatchMcpTool(
      'find_subgraphs_for_address',
      { address: 'kaspa:unknown' },
      handlers,
    )) as FindSubgraphsForAddressOutput;
    expect(empty).toEqual([]);
  });

  it('query_natural_language returns generated query + execution result', async () => {
    const handlers = new InMemoryHandlers();
    const got = (await dispatchMcpTool(
      'query_natural_language',
      { prompt: 'show me recent bonds' },
      handlers,
    )) as QueryNaturalLanguageOutput;
    expect(got.generated_query).toContain('show me recent bonds');
    expect(got.result.data).toBeDefined();
  });

  it('each successful dispatch records exactly one call', async () => {
    const handlers = new InMemoryHandlers();
    await dispatchMcpTool('list_subgraphs', {}, handlers);
    await dispatchMcpTool('get_schema', { subgraph_id: 'x' }, handlers);
    expect(handlers.calls.map((c) => c.tool)).toEqual(['list_subgraphs', 'get_schema']);
  });
});
