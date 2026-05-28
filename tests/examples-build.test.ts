import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runBuild, type CliIo } from '../cli/src/index.js';

// Every example mapping must compile to an ABI-valid wasm module via
// `kasgraph build`. The build runs with the example directory as cwd; because
// each example lives inside this repo, `kasgraph build` finds the hoisted root
// `node_modules` (and thus `@kasgraph/as-mapping` + `assemblyscript-json`) by
// walking ancestors for `--path` roots.

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const examplesDir = path.join(repoRoot, 'examples');

// name → wasm basename (from manifest `name:`) + expected handler exports.
const EXAMPLES: Array<{ dir: string; wasm: string; handlers: string[] }> = [
  {
    dir: 'kasbonds',
    wasm: 'kasbonds.wasm',
    handlers: ['handleBondIssued', 'handleBondTransition'],
  },
  {
    dir: 'krc20',
    wasm: 'krc20.wasm',
    handlers: ['handleAssetOrControllerDeployed', 'handleAssetTransition'],
  },
  {
    dir: 'krc721',
    wasm: 'krc721.wasm',
    handlers: [
      'handleCollectionDeployed',
      'handleNftMinted',
      'handleNftTransferred',
      'handleNftBurned',
    ],
  },
  {
    dir: 'network-stats',
    wasm: 'network_stats.wasm',
    handlers: ['handleBlockAdded', 'handleUtxoChanged'],
  },
  {
    dir: 'opensilver-patterns',
    wasm: 'opensilver_patterns.wasm',
    handlers: ['handlePatternEntry', 'handlePatternTransition'],
  },
  {
    dir: 'zk-proofs',
    wasm: 'zk_proofs.wasm',
    handlers: ['handleVerifyingKeyRegistered', 'handleProvenSpend'],
  },
];

// The only host imports the runtime linker provides.
const ALLOWED_IMPORTS = new Set([
  'kasgraph.log',
  'kasgraph.store_set',
  'kasgraph.store_get',
]);

describe('examples build to ABI-valid wasm', () => {
  for (const ex of EXAMPLES) {
    it(
      `builds ${ex.dir}`,
      async () => {
        const dir = path.join(examplesDir, ex.dir);
        const io = new CapturedIo(dir);

        const code = await runBuild([], io);
        expect(code, io.stderrBuf).toBe(0);

        const wasmPath = path.join(dir, 'build', ex.wasm);
        expect(existsSync(wasmPath)).toBe(true);

        const bytes = await readFile(wasmPath);
        const mod = await WebAssembly.compile(Uint8Array.from(bytes));

        const exports = new Map(
          WebAssembly.Module.exports(mod).map((e) => [e.name, e.kind]),
        );
        expect(exports.get('memory')).toBe('memory');
        expect(exports.get('kasgraph_alloc')).toBe('function');
        for (const h of ex.handlers) {
          expect(exports.get(h), `missing handler export ${h}`).toBe('function');
        }

        const stray = WebAssembly.Module.imports(mod)
          .filter((i) => i.kind === 'function')
          .map((i) => `${i.module}.${i.name}`)
          .filter((name) => !ALLOWED_IMPORTS.has(name));
        expect(stray, `stray host imports: ${stray.join(', ')}`).toEqual([]);
      },
      30_000,
    );
  }
});
