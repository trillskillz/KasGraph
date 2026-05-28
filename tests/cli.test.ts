import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMcpConfig,
  HELP_TEXT,
  parseCommand,
  parseMcpConfigArgs,
  runCommand,
  type CliIo,
} from '../cli/src/index.js';
import { runInit } from '../cli/src/init.js';

class CapturedIo implements CliIo {
  stdoutBuf = '';
  stderrBuf = '';

  constructor(public cwd: string) {}

  get stdout() {
    return {
      write: (s: string): boolean => {
        this.stdoutBuf += s;
        return true;
      },
    };
  }

  get stderr() {
    return {
      write: (s: string): boolean => {
        this.stderrBuf += s;
        return true;
      },
    };
  }
}

async function newScratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kasgraph-cli-'));
}

describe('parseCommand', () => {
  it('recognises every Phase 4 command name', () => {
    for (const cmd of [
      'init',
      'codegen',
      'build',
      'deploy',
      'status',
      'logs',
      'remove',
      'mcp-config',
      'help',
    ]) {
      expect(parseCommand([cmd])).toBe(cmd);
    }
  });

  it('returns help on missing or unknown commands', () => {
    expect(parseCommand([])).toBe('help');
    expect(parseCommand(['nope'])).toBe('help');
  });
});

describe('runCommand dispatch', () => {
  it('prints help to stdout and exits 0 when no command is given', async () => {
    const io = new CapturedIo(await newScratch());
    const code = await runCommand([], io);
    expect(code).toBe(0);
    expect(io.stdoutBuf).toContain('kasgraph — subgraph-style');
    expect(io.stdoutBuf).toBe(HELP_TEXT);
  });

  it('returns 64 for recognised-but-not-implemented commands', async () => {
    const io = new CapturedIo(await newScratch());
    for (const cmd of ['codegen', 'build', 'deploy', 'status', 'logs', 'remove']) {
      io.stderrBuf = '';
      const code = await runCommand([cmd], io);
      expect(code).toBe(64);
      expect(io.stderrBuf).toContain('not implemented yet');
    }
  });
});

describe('kasgraph init', () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await newScratch();
  });

  it('errors when no name is given', async () => {
    const io = new CapturedIo(scratch);
    const code = await runInit([], io);
    expect(code).toBe(64);
    expect(io.stderrBuf).toContain('missing required positional <name>');
  });

  it('rejects invalid names', async () => {
    // Leading dashes are filtered as flags by runInit; the
    // remaining set must hit the regex branch.
    for (const bad of ['Foo', 'has spaces', '../escape', '_starts_with_underscore']) {
      const io = new CapturedIo(scratch);
      const code = await runInit([bad], io);
      expect(code).toBe(64);
      expect(io.stderrBuf).toContain('<name> must be');
    }
  });

  it('scaffolds a working subgraph dir with every expected file', async () => {
    const io = new CapturedIo(scratch);
    const code = await runInit(['kasbonds'], io);
    expect(code).toBe(0);
    expect(io.stdoutBuf).toContain('Scaffolded subgraph at');

    const root = path.join(scratch, 'kasbonds');
    for (const rel of [
      'subgraph.yaml',
      'schema.graphql',
      'src/mapping.ts',
      'package.json',
      '.gitignore',
      'README.md',
    ]) {
      const s = await stat(path.join(root, rel));
      expect(s.isFile()).toBe(true);
    }

    // subgraph.yaml uses the supplied name in the right places.
    const manifest = await readFile(path.join(root, 'subgraph.yaml'), 'utf8');
    expect(manifest).toContain('name: kasbonds');
    expect(manifest).toContain('schema:\n  file: ./schema.graphql');
    expect(manifest).toContain('kind: covenant_id');
    // package.json is valid JSON with the name field.
    const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
      name: string;
      dependencies: Record<string, string>;
    };
    expect(pkg.name).toBe('kasbonds');
    expect(pkg.dependencies['@kasgraph/sdk']).toBeDefined();
    // schema.graphql has the placeholder entity.
    const schema = await readFile(path.join(root, 'schema.graphql'), 'utf8');
    expect(schema).toContain('type Bond');
  });

  it('refuses to clobber an existing directory', async () => {
    const io1 = new CapturedIo(scratch);
    expect(await runInit(['twice'], io1)).toBe(0);
    const io2 = new CapturedIo(scratch);
    const code = await runInit(['twice'], io2);
    expect(code).toBe(73);
    expect(io2.stderrBuf).toContain('refusing to clobber');
  });

  it('runs end-to-end via runCommand("init", ...)', async () => {
    const io = new CapturedIo(scratch);
    const code = await runCommand(['init', 'via-run-command'], io);
    expect(code).toBe(0);
    const s = await stat(path.join(scratch, 'via-run-command', 'subgraph.yaml'));
    expect(s.isFile()).toBe(true);
  });
});

describe('kasgraph mcp-config', () => {
  it('parseMcpConfigArgs returns sensible defaults', () => {
    const opts = parseMcpConfigArgs([]);
    expect(opts.command).toBe('kasgraph-mcp');
    expect(opts.serverName).toBe('kasgraph');
    expect(opts.databaseUrl).toMatch(/USER:PASS/);
  });

  it('parseMcpConfigArgs honors --database-url / --command / --server-name', () => {
    const opts = parseMcpConfigArgs([
      '--database-url',
      'postgres://prod/db',
      '--command',
      '/opt/kasgraph/bin/kasgraph-mcp',
      '--server-name',
      'kg-prod',
    ]);
    expect(opts.databaseUrl).toBe('postgres://prod/db');
    expect(opts.command).toBe('/opt/kasgraph/bin/kasgraph-mcp');
    expect(opts.serverName).toBe('kg-prod');
  });

  it('parseMcpConfigArgs throws on unknown args', () => {
    expect(() => parseMcpConfigArgs(['--bogus'])).toThrow(/unknown argument/);
  });

  it('parseMcpConfigArgs throws when a flag is missing its value', () => {
    expect(() => parseMcpConfigArgs(['--database-url'])).toThrow(/requires a value/);
  });

  it('buildMcpConfig produces the Claude Desktop shape', () => {
    const config = buildMcpConfig({
      databaseUrl: 'postgres://x',
      command: 'kasgraph-mcp',
      serverName: 'kasgraph',
    });
    const expected = {
      mcpServers: {
        kasgraph: {
          command: 'kasgraph-mcp',
          args: [],
          env: { DATABASE_URL: 'postgres://x' },
        },
      },
    };
    expect(config).toEqual(expected);
  });

  it('runCommand("mcp-config") emits valid JSON on stdout', async () => {
    const io = new CapturedIo(await newScratch());
    const code = await runCommand(
      ['mcp-config', '--database-url', 'postgres://u:p@host/kasgraph'],
      io,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(io.stdoutBuf) as {
      mcpServers: { kasgraph: { env: { DATABASE_URL: string } } };
    };
    expect(parsed.mcpServers.kasgraph.env.DATABASE_URL).toBe(
      'postgres://u:p@host/kasgraph',
    );
  });

  it('runCommand("mcp-config", --bogus) exits 64 with a stderr diagnostic', async () => {
    const io = new CapturedIo(await newScratch());
    const code = await runCommand(['mcp-config', '--bogus'], io);
    expect(code).toBe(64);
    expect(io.stderrBuf).toContain('unknown argument');
  });
});

afterEach(() => {
  // CapturedIo + tmpdir cleanup is implicit (OS reclaims); leaving
  // dirs around makes failures easier to reproduce manually.
});
