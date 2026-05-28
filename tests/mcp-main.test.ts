import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  callToolToContent,
  createKasGraphMcpServer,
  type McpHandlers,
  readOptionsFromEnv,
} from '../mcp/src/index.js';

class StubHandlers implements McpHandlers {
  readonly calls: Array<{ tool: string; args: unknown }> = [];

  async list_subgraphs(input: { keyword?: string }) {
    this.calls.push({ tool: 'list_subgraphs', args: input });
    return [{ id: 'kasbonds', name: 'KasBonds', blocks_indexed: 7 }];
  }
  async get_schema(input: { subgraph_id: string }) {
    this.calls.push({ tool: 'get_schema', args: input });
    return { subgraph_id: input.subgraph_id, schema_sdl: 'type Q { ok: String }' };
  }
  async execute_query() {
    return { data: { ok: true } };
  }
  async search_by_pattern() {
    return [];
  }
  async get_covenant_lineage(input: { covenant_id: string }) {
    return { covenant_id: input.covenant_id, lineage: [] };
  }
  async get_address_activity() {
    return [];
  }
  async find_subgraphs_for_address() {
    return [];
  }
  async query_natural_language(input: { prompt: string }) {
    return {
      generated_query: '{ ok }',
      result: { data: { ok: input.prompt.length } },
    };
  }
}

describe('createKasGraphMcpServer', () => {
  it('constructs without throwing', () => {
    const server = createKasGraphMcpServer(new StubHandlers());
    expect(server).toBeDefined();
  });
});

describe('callToolToContent', () => {
  it('wraps successful results in a single text content block', async () => {
    const handlers = new StubHandlers();
    const got = await callToolToContent('list_subgraphs', {}, handlers);
    expect(got.isError).toBeUndefined();
    expect(got.content).toHaveLength(1);
    expect(got.content[0]!.type).toBe('text');
    const decoded = JSON.parse(got.content[0]!.text) as Array<{ id: string }>;
    expect(decoded[0]!.id).toBe('kasbonds');
    expect(handlers.calls[0]?.tool).toBe('list_subgraphs');
  });

  it('routes args through the dispatcher and forwards required fields', async () => {
    const handlers = new StubHandlers();
    const got = await callToolToContent(
      'get_schema',
      { subgraph_id: 'kasbonds' },
      handlers,
    );
    const decoded = JSON.parse(got.content[0]!.text) as {
      subgraph_id: string;
      schema_sdl: string;
    };
    expect(decoded.subgraph_id).toBe('kasbonds');
    expect(decoded.schema_sdl).toContain('type Q');
  });

  it('marks unknown tools with isError + an `unknown_tool` code', async () => {
    const handlers = new StubHandlers();
    const got = await callToolToContent('not_a_tool', {}, handlers);
    expect(got.isError).toBe(true);
    const decoded = JSON.parse(got.content[0]!.text) as {
      code: string;
      error: string;
    };
    expect(decoded.code).toBe('unknown_tool');
    expect(decoded.error).toMatch(/not_a_tool/);
  });

  it('marks missing-required-field calls with isError + `invalid_input`', async () => {
    const handlers = new StubHandlers();
    const got = await callToolToContent('get_schema', {}, handlers);
    expect(got.isError).toBe(true);
    const decoded = JSON.parse(got.content[0]!.text) as {
      code: string;
      error: string;
    };
    expect(decoded.code).toBe('invalid_input');
  });

  it('marks handler-thrown errors with isError + `handler_error`', async () => {
    const angry: McpHandlers = {
      ...new StubHandlers(),
      async list_subgraphs() {
        throw new Error('db is on fire');
      },
    };
    const got = await callToolToContent('list_subgraphs', {}, angry);
    expect(got.isError).toBe(true);
    const decoded = JSON.parse(got.content[0]!.text) as {
      code: string;
      error: string;
    };
    expect(decoded.code).toBe('handler_error');
    expect(decoded.error).toContain('db is on fire');
  });
});

describe('readOptionsFromEnv (mcp)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.KASGRAPH_DATABASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when neither env var is set', () => {
    expect(() => readOptionsFromEnv()).toThrow(/DATABASE_URL/);
  });

  it('accepts DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://x';
    expect(readOptionsFromEnv().databaseUrl).toBe('postgres://x');
  });

  it('falls back to KASGRAPH_DATABASE_URL', () => {
    process.env.KASGRAPH_DATABASE_URL = 'postgres://y';
    expect(readOptionsFromEnv().databaseUrl).toBe('postgres://y');
  });

  it('DATABASE_URL takes precedence over KASGRAPH_DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgres://x';
    process.env.KASGRAPH_DATABASE_URL = 'postgres://y';
    expect(readOptionsFromEnv().databaseUrl).toBe('postgres://x');
  });
});
