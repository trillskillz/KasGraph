// `kasgraph build` — compile a subgraph's AssemblyScript mapping to a
// WebAssembly module that the Phase 2.6 `kasgraph-mapping` runtime can
// load and dispatch.
//
// The runtime ABI (see crates/kasgraph-mapping):
//   guest exports  memory
//                  kasgraph_alloc(i32) -> i32
//                  one handler(ptr: i32, len: i32) per manifest handler
//   guest imports  kasgraph.log(level: i32, ptr: i32, len: i32)
//                  kasgraph.store_set(ptr: i32, len: i32)
//                  kasgraph.store_get(ePtr,eLen,idPtr,idLen: i32) -> i64
//
// build resolves the handler names + mapping file(s) from subgraph.yaml,
// generates a thin AssemblyScript entry module (`build/entry.ts`) that
// supplies `kasgraph_alloc` and re-exports each manifest handler under
// the name the runtime looks up, then drives the AssemblyScript compiler
// (`asc`) with determinism-matching flags. The produced wasm is verified
// against the ABI before the command reports success: the required
// exports must be present and no host import outside the `kasgraph.*`
// surface the runtime linker provides may remain (this also rejects the
// stray `env.abort` AssemblyScript would otherwise emit).
//
// NOTE: the mapping must be authored in AssemblyScript (a strict TS
// subset — no async/Promise/closures). The reference mappings under
// examples/ are still aspirational pseudo-code and do not yet compile;
// porting them to AssemblyScript is a separate task.

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

import type { CliIo } from './index.js';

interface SubgraphManifest {
  name?: string;
  dataSources?: Array<{
    name?: string;
    mapping?: {
      file?: string;
      handlers?: Array<{ event?: string; handler?: string }>;
    };
  }>;
}

export interface BuildResult {
  wasmPath: string;
  byteLength: number;
  handlers: string[];
}

// asc determinism flags. `--runtime stub` gives a minimal bump allocator
// (which backs kasgraph_alloc) with no GC; `--use abort=` drops the
// `env.abort` import the runtime linker does not provide (an aborting
// handler traps, which the runtime classifies as HandlerTrap). No SIMD
// or threads features are enabled, matching the runtime Engine config.
const ASC_FLAGS = ['--optimize', '--runtime', 'stub', '--use', 'abort='];

// The only host imports the Phase 2.6 runtime linker defines.
const ALLOWED_IMPORTS = new Set([
  'kasgraph.log',
  'kasgraph.store_set',
  'kasgraph.store_get',
]);

const DEFAULT_MAPPING_FILE = './src/mapping.ts';

export async function runBuild(_args: string[], io: CliIo): Promise<number> {
  const root = io.cwd;
  const manifestPath = path.join(root, 'subgraph.yaml');

  if (!existsSync(manifestPath)) {
    io.stderr.write(`kasgraph build: ${manifestPath} not found\n`);
    return 66; // EX_NOINPUT
  }

  let manifest: SubgraphManifest;
  try {
    manifest = parseYaml(await readFile(manifestPath, 'utf8')) as SubgraphManifest;
  } catch (err) {
    io.stderr.write(
      `kasgraph build: failed to parse subgraph.yaml: ${errText(err)}\n`,
    );
    return 65; // EX_DATAERR
  }

  // Map each manifest handler to the mapping file that defines it.
  const handlerFile = new Map<string, string>();
  const order: string[] = [];
  for (const ds of manifest.dataSources ?? []) {
    const fileRel = ds.mapping?.file ?? DEFAULT_MAPPING_FILE;
    const fileAbs = path.resolve(root, fileRel);
    for (const h of ds.mapping?.handlers ?? []) {
      if (!h.handler) continue;
      const existing = handlerFile.get(h.handler);
      if (existing !== undefined && existing !== fileAbs) {
        io.stderr.write(
          `kasgraph build: handler \`${h.handler}\` is claimed by two mapping files ` +
            `(${path.relative(root, existing)} and ${path.relative(root, fileAbs)})\n`,
        );
        return 65;
      }
      if (existing === undefined) {
        handlerFile.set(h.handler, fileAbs);
        order.push(h.handler);
      }
    }
  }

  if (order.length === 0) {
    io.stderr.write(
      'kasgraph build: no handlers declared in subgraph.yaml dataSources[].mapping.handlers\n',
    );
    return 65;
  }

  // Every referenced mapping file must exist.
  for (const file of new Set(handlerFile.values())) {
    if (!existsSync(file)) {
      io.stderr.write(
        `kasgraph build: mapping file ${path.relative(root, file)} not found\n`,
      );
      return 66;
    }
  }

  // Resolve the AssemblyScript compiler lazily so a missing toolchain is
  // a clear, actionable error rather than a module-load crash.
  let asc: AscModule;
  try {
    asc = ((await import('assemblyscript/asc')) as { default: AscModule }).default;
  } catch {
    io.stderr.write(
      'kasgraph build: AssemblyScript compiler not found. Install it with ' +
        '`npm i -D assemblyscript`.\n',
    );
    return 69; // EX_UNAVAILABLE
  }

  const outDir = path.join(root, 'build');
  await mkdir(outDir, { recursive: true });

  const entrySource = renderEntry(outDir, order, handlerFile);
  const entryPath = path.join(outDir, 'entry.ts');
  await writeFile(entryPath, entrySource, 'utf8');

  const wasmName = `${sanitizeName(manifest.name) || 'subgraph'}.wasm`;
  const wasmPath = path.join(outDir, wasmName);

  // asc resolves bare library imports (the AS SDK, assemblyscript-json)
  // from `baseDir/node_modules` and any `--path` roots, and does NOT walk
  // up the tree. A user's own subgraph install resolves via baseDir; the
  // in-repo examples rely on hoisted deps further up, so add every
  // ancestor node_modules as a search path.
  const libPaths = ancestorNodeModules(root).flatMap((p) => ['--path', p]);

  const diagnostics = asc.createMemoryStream();
  const { error } = await asc.main(
    [entryPath, '-o', wasmPath, '--baseDir', root, ...libPaths, ...ASC_FLAGS],
    { stdout: diagnostics, stderr: diagnostics },
  );

  if (error) {
    io.stderr.write(`kasgraph build: AssemblyScript compilation failed:\n`);
    io.stderr.write(indent(diagnostics.toString() || String(error)));
    return 65;
  }

  // Verify the produced module against the runtime ABI before claiming
  // success — a mapping that compiles can still violate the contract.
  const bytes = await readFile(wasmPath);
  const abiError = await verifyAbi(bytes, order);
  if (abiError) {
    io.stderr.write(`kasgraph build: ${abiError}\n`);
    return 65;
  }

  io.stdout.write(
    [
      'Build complete:',
      `  ${order.length} handler${order.length === 1 ? '' : 's'} → ${wasmPath}`,
      `  ${bytes.byteLength} bytes`,
      '',
    ].join('\n'),
  );
  return 0;
}

// ----------------------------------------------------------------
// Entry-module generation
// ----------------------------------------------------------------

function renderEntry(
  outDir: string,
  handlers: string[],
  handlerFile: Map<string, string>,
): string {
  // Group handlers by their source file so each file is imported once.
  const byFile = new Map<string, string[]>();
  for (const handler of handlers) {
    const file = handlerFile.get(handler)!;
    const list = byFile.get(file) ?? [];
    list.push(handler);
    byFile.set(file, list);
  }

  const imports: string[] = [];
  for (const [file, names] of byFile) {
    const spec = importSpecifier(outDir, file);
    const bindings = names.map((n) => `${n} as ${alias(n)}`).join(', ');
    imports.push(`import { ${bindings} } from ${JSON.stringify(spec)};`);
  }

  const wrappers = handlers.map(
    (h) =>
      `export function ${h}(ptr: i32, len: i32): void {\n` +
      `  ${alias(h)}(ptr, len);\n}`,
  );

  return [
    '// Generated by `kasgraph build` — do not edit.',
    '// Supplies the runtime allocator and re-exports each manifest',
    '// handler under the name the kasgraph-mapping runtime looks up.',
    '',
    ...imports,
    '',
    '// Bump-allocate `size` bytes of guest memory; the host writes the',
    '// event JSON here before invoking a handler.',
    'export function kasgraph_alloc(size: i32): i32 {',
    '  return changetype<i32>(heap.alloc(size));',
    '}',
    '',
    ...wrappers,
    '',
  ].join('\n');
}

function alias(handler: string): string {
  return `__kg_${handler}`;
}

// Module specifier for an AssemblyScript import, relative to the entry
// file's directory, extension stripped, POSIX separators (asc resolves
// relative imports against the importing file's location).
function importSpecifier(fromDir: string, targetFile: string): string {
  let rel = path.relative(fromDir, targetFile).split(path.sep).join('/');
  rel = rel.replace(/\.ts$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

// ----------------------------------------------------------------
// ABI verification
// ----------------------------------------------------------------

async function verifyAbi(
  bytes: Uint8Array,
  handlers: string[],
): Promise<string | null> {
  let mod: WebAssembly.Module;
  try {
    // Copy into a fresh ArrayBuffer-backed view so the type matches
    // `BufferSource` (a Node Buffer is typed over ArrayBufferLike).
    mod = await WebAssembly.compile(Uint8Array.from(bytes));
  } catch (err) {
    return `produced module failed to validate as WebAssembly: ${errText(err)}`;
  }

  const exports = new Map(
    WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]),
  );

  if (exports.get('memory') !== 'memory') {
    return 'produced module does not export `memory`';
  }
  if (exports.get('kasgraph_alloc') !== 'function') {
    return 'produced module does not export `kasgraph_alloc` (function)';
  }
  const missing = handlers.filter((h) => exports.get(h) !== 'function');
  if (missing.length > 0) {
    return `produced module is missing handler export(s): ${missing.join(', ')}`;
  }

  const stray = WebAssembly.Module.imports(mod)
    .filter((i) => i.kind === 'function')
    .map((i) => `${i.module}.${i.name}`)
    .filter((name) => !ALLOWED_IMPORTS.has(name));
  if (stray.length > 0) {
    return (
      `produced module imports host functions the runtime does not provide: ` +
      `${stray.join(', ')} (allowed: ${[...ALLOWED_IMPORTS].join(', ')})`
    );
  }

  return null;
}

// ----------------------------------------------------------------
// Misc
// ----------------------------------------------------------------

function sanitizeName(name: string | undefined): string {
  return (name ?? '').replace(/[^A-Za-z0-9._-]/g, '-');
}

// Every existing `node_modules` directory from `start` up to the
// filesystem root, nearest first.
function ancestorNodeModules(start: string): string[] {
  const found: string[] = [];
  let dir = path.resolve(start);
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (existsSync(candidate)) found.push(candidate);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.length > 0 ? `  ${line}` : line))
    .join('\n');
}

// Minimal shape of the bits of `assemblyscript/asc` we use.
interface AscMemoryStream {
  toString(): string;
}
interface AscModule {
  main(
    argv: string[],
    options: { stdout?: AscMemoryStream; stderr?: AscMemoryStream },
  ): Promise<{ error: Error | null }>;
  createMemoryStream(): AscMemoryStream;
}
