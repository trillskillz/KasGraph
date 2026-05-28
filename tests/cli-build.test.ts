import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runBuild, type CliIo } from '../cli/src/index.js';

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
  return mkdtemp(path.join(tmpdir(), 'kasgraph-build-'));
}

// A minimal AssemblyScript mapping that satisfies the runtime ABI: it
// declares the two host imports and exports raw `(ptr, len)` handlers.
const AS_MAPPING = `
// @ts-ignore: decorator
@external("kasgraph", "log")
declare function host_log(level: i32, ptr: i32, len: i32): void;
// @ts-ignore: decorator
@external("kasgraph", "store_set")
declare function host_store_set(ptr: i32, len: i32): void;

export function handleLocked(ptr: i32, len: i32): void {
  host_log(1, ptr, len);
}

export function handleSpent(ptr: i32, len: i32): void {
  host_store_set(ptr, len);
}
`;

function manifest(mappingFile = './src/mapping.ts'): string {
  return [
    'name: build-fixture',
    'specVersion: 0.0.1',
    'schema:',
    '  file: ./schema.graphql',
    'dataSources:',
    '  - name: cov',
    '    kind: covenant_id',
    '    network: mainnet',
    '    mapping:',
    `      file: ${mappingFile}`,
    '      handlers:',
    '        - event: CovenantLocked',
    '          handler: handleLocked',
    '        - event: CovenantSpent',
    '          handler: handleSpent',
    '',
  ].join('\n');
}

async function scaffold(opts?: {
  mapping?: string;
  manifestBody?: string;
}): Promise<string> {
  const dir = await newScratch();
  await writeFile(path.join(dir, 'subgraph.yaml'), opts?.manifestBody ?? manifest());
  await mkdir(path.join(dir, 'src'), { recursive: true });
  if (opts?.mapping !== '') {
    await writeFile(path.join(dir, 'src', 'mapping.ts'), opts?.mapping ?? AS_MAPPING);
  }
  return dir;
}

describe('kasgraph build', () => {
  it('compiles an AssemblyScript mapping to an ABI-compliant wasm', async () => {
    const dir = await scaffold();
    const io = new CapturedIo(dir);
    const code = await runBuild([], io);
    expect(code, io.stderrBuf).toBe(0);
    expect(io.stdoutBuf).toContain('Build complete');
    expect(io.stdoutBuf).toContain('2 handlers');

    const wasm = await readFile(path.join(dir, 'build', 'build-fixture.wasm'));
    expect(wasm.byteLength).toBeGreaterThan(0);

    // The produced module must match the Phase 2.6 runtime ABI exactly.
    const mod = await WebAssembly.compile(Uint8Array.from(wasm));
    const exports = new Map(
      WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]),
    );
    expect(exports.get('memory')).toBe('memory');
    expect(exports.get('kasgraph_alloc')).toBe('function');
    expect(exports.get('handleLocked')).toBe('function');
    expect(exports.get('handleSpent')).toBe('function');

    const imports = WebAssembly.Module.imports(mod)
      .map((i) => `${i.module}.${i.name}`)
      .sort();
    expect(imports).toEqual(['kasgraph.log', 'kasgraph.store_set']);
  });

  it('generates a build/entry.ts that supplies kasgraph_alloc + re-exports handlers', async () => {
    const dir = await scaffold();
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(0);
    const entry = await readFile(path.join(dir, 'build', 'entry.ts'), 'utf8');
    expect(entry).toContain('export function kasgraph_alloc(size: i32): i32');
    expect(entry).toContain('heap.alloc(size)');
    expect(entry).toContain('export function handleLocked(ptr: i32, len: i32)');
    expect(entry).toContain('export function handleSpent(ptr: i32, len: i32)');
    // Imports the user mapping by a relative, extension-less specifier.
    expect(entry).toContain('from "../src/mapping"');
  });

  it('errors when subgraph.yaml is missing', async () => {
    const dir = await newScratch();
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(66);
    expect(io.stderrBuf).toContain('subgraph.yaml not found');
  });

  it('errors when the referenced mapping file is missing', async () => {
    const dir = await scaffold({ mapping: '' });
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(66);
    expect(io.stderrBuf).toContain('mapping file');
    expect(io.stderrBuf).toContain('not found');
  });

  it('errors when no handlers are declared', async () => {
    const body = [
      'name: empty',
      'specVersion: 0.0.1',
      'schema:',
      '  file: ./schema.graphql',
      'dataSources:',
      '  - name: cov',
      '    kind: covenant_id',
      '    network: mainnet',
      '    mapping:',
      '      file: ./src/mapping.ts',
      '      handlers: []',
      '',
    ].join('\n');
    const dir = await scaffold({ manifestBody: body });
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(65);
    expect(io.stderrBuf).toContain('no handlers declared');
  });

  it('surfaces AssemblyScript compile errors with diagnostics', async () => {
    const broken = AS_MAPPING + '\nthis is not valid assemblyscript @#$\n';
    const dir = await scaffold({ mapping: broken });
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(65);
    expect(io.stderrBuf).toContain('AssemblyScript compilation failed');
  });

  it('rejects a mapping that is missing a declared handler export', async () => {
    // Manifest declares handleSpent, but the mapping only exports handleLocked.
    const partial = `
// @ts-ignore: decorator
@external("kasgraph", "log")
declare function host_log(level: i32, ptr: i32, len: i32): void;
export function handleLocked(ptr: i32, len: i32): void {
  host_log(1, ptr, len);
}
`;
    const dir = await scaffold({ mapping: partial });
    const io = new CapturedIo(dir);
    // The generated entry imports handleSpent, which doesn't exist →
    // asc fails to resolve it, surfaced as a compile error.
    expect(await runBuild([], io)).toBe(65);
    expect(io.stderrBuf).toContain('AssemblyScript compilation failed');
  });

  it('rejects a mapping that imports a host function the runtime does not provide', async () => {
    const strayImport = `
// @ts-ignore: decorator
@external("env", "rand")
declare function host_rand(): i32;
export function handleLocked(ptr: i32, len: i32): void {
  host_rand();
}
export function handleSpent(ptr: i32, len: i32): void {}
`;
    const dir = await scaffold({ mapping: strayImport });
    const io = new CapturedIo(dir);
    expect(await runBuild([], io)).toBe(65);
    expect(io.stderrBuf).toContain('imports host functions the runtime does not provide');
    expect(io.stderrBuf).toContain('env.rand');
  });
});
