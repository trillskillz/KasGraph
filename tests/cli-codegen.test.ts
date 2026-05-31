import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { runCodegen, runCommand, type CliIo } from '../cli/src/index.js';
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

async function scratch(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'kasgraph-codegen-'));
}

async function writeFixture(
  root: string,
  manifest: string,
  schema: string,
): Promise<void> {
  await writeFile(path.join(root, 'subgraph.yaml'), manifest, 'utf8');
  await writeFile(path.join(root, 'schema.graphql'), schema, 'utf8');
}

describe('kasgraph codegen — input validation', () => {
  it('errors when subgraph.yaml is missing', async () => {
    const root = await scratch();
    await writeFile(path.join(root, 'schema.graphql'), 'type X { id: ID! }', 'utf8');
    const io = new CapturedIo(root);
    const code = await runCodegen([], io);
    expect(code).toBe(66);
    expect(io.stderrBuf).toContain('subgraph.yaml not found');
  });

  it('errors when schema.graphql is missing', async () => {
    const root = await scratch();
    await writeFile(path.join(root, 'subgraph.yaml'), 'name: x\n', 'utf8');
    const io = new CapturedIo(root);
    const code = await runCodegen([], io);
    expect(code).toBe(66);
    expect(io.stderrBuf).toContain('schema.graphql not found');
  });

  it('errors on malformed SDL', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      'type X { id: ID! :::garbage }',
    );
    const io = new CapturedIo(root);
    const code = await runCodegen([], io);
    expect(code).toBe(65);
    expect(io.stderrBuf).toContain('failed to parse schema.graphql');
  });
});

describe('kasgraph codegen — entity rendering', () => {
  let root: string;
  beforeEach(async () => {
    root = await scratch();
  });

  it('maps scalars to TypeScript types', async () => {
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: ds
    mapping:
      handlers: []
`,
      `type Bond {
        id: ID!
        issuer: String!
        nickname: String
        faceValueSompi: BigInt!
        couponBps: Int
        floatRate: Float
        active: Boolean!
        scriptBytes: Bytes
        payload: JSON
      }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/entities.ts'), 'utf8');
    expect(out).toContain('export interface Bond');
    expect(out).toContain('id: string;');
    expect(out).toContain('issuer: string;');
    expect(out).toContain('nickname?: string;');
    expect(out).toContain('faceValueSompi: bigint;');
    expect(out).toContain('couponBps?: number;');
    expect(out).toContain('floatRate?: number;');
    expect(out).toContain('active: boolean;');
    expect(out).toContain('scriptBytes?: string;');
    expect(out).toContain('payload?: unknown;');
  });

  it('renders list types as Array<...> with inner nullability', async () => {
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      `type Group {
        members: [String!]!
        sometimesMembers: [String]
        nullableArrayOfRequired: [Bond!]
      }
      type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/entities.ts'), 'utf8');
    expect(out).toContain('members: Array<string>;');
    expect(out).toContain('sometimesMembers?: Array<string | null>;');
    // Object-type references stay as the interface name.
    expect(out).toContain('nullableArrayOfRequired?: Array<Bond>;');
  });

  it('keeps object-type references as the referenced interface name', async () => {
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      `type Holding {
        bond: Bond!
        prevHolding: Holding
      }
      type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/entities.ts'), 'utf8');
    expect(out).toContain('bond: Bond;');
    expect(out).toContain('prevHolding?: Holding;');
  });

  it('skips Query / Mutation / Subscription root types', async () => {
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      `type Query { bonds: [Bond!]! }
      type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/entities.ts'), 'utf8');
    expect(out).not.toContain('export interface Query');
    expect(out).toContain('export interface Bond');
  });
});

describe('kasgraph codegen — event rendering', () => {
  it('emits one interface per handler with the standard envelope', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: ds-a
    mapping:
      handlers:
        - event: CovenantLocked
          handler: handleCovenantLocked
        - event: CovenantSpent
          handler: handleCovenantSpent
  - name: ds-b
    mapping:
      handlers:
        - event: KCC20Mint
          handler: handleMint
`,
      `type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/events.ts'), 'utf8');
    expect(out).toContain('export interface CovenantLockedEvent');
    expect(out).toContain('export interface CovenantSpentEvent');
    expect(out).toContain('export interface KCC20MintEvent');
    // Standard envelope appears in every interface.
    expect(out).toContain('block: {');
    expect(out).toContain('tx: {');
    expect(out).toContain('payload: unknown;');
    // Event-name literal matches the manifest entry verbatim.
    expect(out).toContain('event: "CovenantLocked";');
    expect(out).toContain('event: "KCC20Mint";');
  });

  it('types payloads from registered detector patterns as a discriminated union', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: ds
    kind: covenant_id
    source:
      ids:
        - pattern: OpenSilverVault
        - pattern: OpenSilverMultisig
    mapping:
      handlers:
        - event: CovenantLocked
          handler: handleLock
`,
      `type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/events.ts'), 'utf8');
    // One State interface per referenced pattern, hex fields as strings.
    expect(out).toContain('export interface OpenSilverVaultState');
    expect(out).toContain('detectorKind: "OpenSilverVault";');
    expect(out).toContain('covenantId?: string;');
    expect(out).toContain('  owner_pubkey: string;');
    expect(out).toContain('export interface OpenSilverMultisigState');
    expect(out).toContain('  threshold: string;');
    expect(out).toContain('  signer_pubkey_1: string;');
    // Payload is the union of the data source's pattern states.
    expect(out).toContain(
      'payload: OpenSilverMultisigState | OpenSilverVaultState;',
    );
    expect(out).not.toContain('payload: unknown;');
  });

  it('leaves state `unknown` for unregistered patterns and pattern-less sources', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: zk
    kind: covenant_id
    source:
      ids:
        - pattern: ZkVerifierGroth16
    mapping:
      handlers:
        - event: CovenantSpent
          handler: handleProvenSpend
  - name: stats
    kind: utxo
    source:
      addresses: ["*"]
    mapping:
      handlers:
        - event: UtxoChanged
          handler: handleUtxoChanged
`,
      `type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/events.ts'), 'utf8');
    // Unregistered pattern → no `<Kind>State` interface emitted.
    expect(out).not.toContain('detectorKind');
    // A covenant_id spend still carries the protocol-level spend
    // envelope, with `state: unknown` because the pattern is unregistered.
    expect(out).toContain('export interface CovenantSpend');
    expect(out).toContain('covenantId: string;');
    expect(out).toContain('payload: { spend: CovenantSpend; state: unknown };');
    // The utxo firehose carries no covenant semantics → plain `unknown`.
    expect(out).toContain('payload: unknown;');
  });

  it('attaches the spend envelope only to CovenantSpent, not CovenantLocked', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: ds
    kind: covenant_id
    source:
      ids:
        - pattern: OpenSilverVault
    mapping:
      handlers:
        - event: CovenantLocked
          handler: handleLock
        - event: CovenantSpent
          handler: handleSpend
`,
      `type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/events.ts'), 'utf8');
    // Shared envelope emitted once with the protocol-level fields.
    expect(out).toContain('export interface CovenantSpend');
    expect(out).toContain('covenantId: string;');
    expect(out).toContain('operation: string;');
    expect(out).toContain('spentValueSompi: string;');
    expect(out).toContain('successorCovenantId: string | null;');
    // Lock event: plain state union, no spend envelope.
    expect(out).toContain('payload: OpenSilverVaultState;');
    // Spend event: state union wrapped in the spend envelope.
    expect(out).toContain(
      'payload: { spend: CovenantSpend; state: OpenSilverVaultState };',
    );
  });

  it('emits `export {};` when the manifest has no handlers', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources:
  - name: ds
    mapping:
      handlers: []
`,
      `type Bond { id: ID! }`,
    );
    const code = await runCodegen([], new CapturedIo(root));
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/events.ts'), 'utf8');
    expect(out).toContain('export {};');
    expect(out).not.toContain('export interface');
  });
});

describe('kasgraph codegen — end-to-end with `kasgraph init`', () => {
  it('init + codegen produces the files mapping.ts references', async () => {
    const root = await scratch();
    const ioInit = new CapturedIo(root);
    expect(await runInit(['demo'], ioInit)).toBe(0);

    const subgraphDir = path.join(root, 'demo');
    const ioCodegen = new CapturedIo(subgraphDir);
    const code = await runCodegen([], ioCodegen);
    expect(code).toBe(0);
    expect(ioCodegen.stdoutBuf).toContain('Codegen complete');

    // Match the imports in the init template's mapping.ts.
    const events = await readFile(
      path.join(subgraphDir, 'src/generated/events.ts'),
      'utf8',
    );
    expect(events).toContain('export interface CovenantLockedEvent');
    expect(events).toContain('export interface CovenantSpentEvent');

    const entities = await readFile(
      path.join(subgraphDir, 'src/generated/entities.ts'),
      'utf8',
    );
    expect(entities).toContain('export interface Bond');
  });

  it('runs end-to-end via runCommand("codegen")', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      `type Bond { id: ID! }`,
    );
    const io = new CapturedIo(root);
    const code = await runCommand(['codegen'], io);
    expect(code).toBe(0);
  });

  it('regenerates over an existing src/generated dir', async () => {
    const root = await scratch();
    await writeFixture(
      root,
      `name: x
dataSources: []
`,
      `type Bond { id: ID! }`,
    );
    await mkdir(path.join(root, 'src/generated'), { recursive: true });
    await writeFile(
      path.join(root, 'src/generated/entities.ts'),
      '// stale\n',
      'utf8',
    );
    const io = new CapturedIo(root);
    const code = await runCodegen([], io);
    expect(code).toBe(0);
    const out = await readFile(path.join(root, 'src/generated/entities.ts'), 'utf8');
    expect(out).not.toContain('stale');
    expect(out).toContain('export interface Bond');
  });
});
