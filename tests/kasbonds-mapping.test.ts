import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

type EntityData = Record<string, unknown>;
type StoreKey = `${string}:${string}`;

class MappingHarness {
  readonly entities = new Map<StoreKey, EntityData>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();
  private memory!: WebAssembly.Memory;
  private alloc!: (len: number) => number;
  private exports!: Record<string, WebAssembly.ExportValue>;

  static async load(wasmPath: string): Promise<MappingHarness> {
    const harness = new MappingHarness();
    const wasm = await readFile(wasmPath);
    const imports = {
      kasgraph: {
        log: () => {},
        store_set: (ptr: number, len: number) => harness.storeSet(ptr, len),
        store_get: (ePtr: number, eLen: number, idPtr: number, idLen: number): bigint =>
          harness.storeGet(ePtr, eLen, idPtr, idLen),
      },
    };
    const { instance } = await WebAssembly.instantiate(wasm, imports);
    harness.exports = instance.exports as Record<string, WebAssembly.ExportValue>;
    harness.memory = harness.exports['memory'] as WebAssembly.Memory;
    harness.alloc = harness.exports['kasgraph_alloc'] as (len: number) => number;
    return harness;
  }

  dispatch(handler: 'handleBondIssued' | 'handleBondTransition', event: unknown): void {
    const bytes = this.encoder.encode(JSON.stringify(event));
    const ptr = this.alloc(bytes.byteLength);
    new Uint8Array(this.memory.buffer, ptr, bytes.byteLength).set(bytes);
    (this.exports[handler] as (ptr: number, len: number) => void)(ptr, bytes.byteLength);
  }

  private storeSet(ptr: number, len: number): void {
    const raw = this.readUtf8(ptr, len);
    const op = JSON.parse(raw) as { entity: string; id: string; data: EntityData };
    this.entities.set(`${op.entity}:${op.id}`, op.data);
  }

  private storeGet(ePtr: number, eLen: number, idPtr: number, idLen: number): bigint {
    const entity = this.readUtf8(ePtr, eLen);
    const id = this.readUtf8(idPtr, idLen);
    const data = this.entities.get(`${entity}:${id}`);
    if (data === undefined) return 0n;
    const bytes = this.encoder.encode(JSON.stringify(data));
    const ptr = this.alloc(bytes.byteLength);
    new Uint8Array(this.memory.buffer, ptr, bytes.byteLength).set(bytes);
    return (BigInt(ptr) << 32n) | BigInt(bytes.byteLength);
  }

  private readUtf8(ptr: number, len: number): string {
    return this.decoder.decode(new Uint8Array(this.memory.buffer, ptr, len));
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const kasbondsDir = path.join(repoRoot, 'examples', 'kasbonds');
const kasbondsWasm = path.join(kasbondsDir, 'build', 'kasbonds.wasm');

describe('KasBonds mapping stable identity', () => {
  beforeAll(async () => {
    const io = new CapturedIo(kasbondsDir);
    const code = await runBuild([], io);
    expect(code, io.stderrBuf || io.stdoutBuf).toBe(0);
  }, 30_000);

  it('keys issue, coupon, and redemption writes by covenant id across later blocks', async () => {
    const harness = await MappingHarness.load(kasbondsWasm);

    harness.dispatch('handleBondIssued', {
      block: { hash: 'issue-block', daaScore: 100 },
      payload: {
        covenantId: 'bond-cov-1',
        detectorKind: 'OpenSilverVault',
        owner_pubkey: 'issuer-pubkey',
      },
    });

    expect(harness.entities.get('Bond:bond-cov-1')).toMatchObject({
      covenantId: 'bond-cov-1',
      issuer: 'issuer-pubkey',
      redeemed: false,
    });
    expect(harness.entities.has('Bond:issue-block')).toBe(false);

    harness.dispatch('handleBondTransition', {
      block: { hash: 'coupon-block', daaScore: 150 },
      payload: {
        spend: {
          covenantId: 'bond-cov-1',
          operation: 'coupon',
          spentValueSompi: '2500',
          successorCovenantId: 'bond-cov-1-next',
        },
        state: { covenantId: 'bond-cov-1' },
      },
    });

    expect(harness.entities.get('Coupon:bond-cov-1-bond-cov-1-next')).toMatchObject({
      bond: 'bond-cov-1',
      paidAtDaa: 150,
      amountSompi: '2500',
    });

    harness.dispatch('handleBondTransition', {
      block: { hash: 'redeem-block', daaScore: 200 },
      payload: {
        spend: {
          covenantId: 'bond-cov-1',
          operation: 'redeem',
          spentValueSompi: '10000',
          successorCovenantId: '',
        },
        state: { covenantId: 'bond-cov-1' },
      },
    });

    expect(harness.entities.get('Bond:bond-cov-1')).toMatchObject({
      covenantId: 'bond-cov-1',
      issuer: 'issuer-pubkey',
      redeemed: true,
    });
    expect(harness.entities.has('Bond:redeem-block')).toBe(false);
  });
});
