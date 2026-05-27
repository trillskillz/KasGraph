import { describe, expect, it } from 'vitest';
import {
  executeGraphQLQuery,
  getKasGraphSchema,
  KASGRAPH_BASE_SCHEMA_SDL,
  type CommittedBlock,
  type CommittedBlockArgs,
  type CommittedBlocksArgs,
  type CovenantLineage,
  type CovenantLineageArgs,
  type DetectedPattern,
  type DetectedPatternsArgs,
  type GatewayResolvers,
  type PoiCheckpoint,
  type PoiCheckpointsArgs,
} from '../api/src/index.js';

// In-memory resolvers backed by seeded arrays. Mirrors the
// per-subgraph Postgres data the production gateway will query.
class InMemoryResolvers implements GatewayResolvers {
  readonly calls: Array<{ field: string; args: unknown }> = [];

  private readonly committedBlocksStore: CommittedBlock[] = [
    {
      subgraph: 'kasbonds',
      blockHash: 'h1',
      daaScore: '100',
      servedBy: 'wrpc',
      committedAt: '2026-05-26T12:00:00Z',
    },
    {
      subgraph: 'kasbonds',
      blockHash: 'h2',
      daaScore: '101',
      servedBy: 'wrpc',
      committedAt: '2026-05-26T12:00:01Z',
    },
    {
      subgraph: 'opensilver_patterns',
      blockHash: 'h3',
      daaScore: '102',
      servedBy: 'wrpc',
      committedAt: '2026-05-26T12:00:02Z',
    },
  ];

  private readonly poiStore: PoiCheckpoint[] = [
    { subgraph: 'kasbonds', blockDaaScore: '100', poiHashHex: 'aa' },
    { subgraph: 'kasbonds', blockDaaScore: '101', poiHashHex: 'bb' },
  ];

  private readonly detectedStore: DetectedPattern[] = [
    {
      subgraph: 'kasbonds',
      blockHash: 'h1',
      blockDaaScore: '100',
      txHash: 't1',
      outputIndex: 0,
      detectorKind: 'OpenSilverVault',
      covenantId: '0xabc',
      payload: { owner: 'k1' },
    },
    {
      subgraph: 'kasbonds',
      blockHash: 'h2',
      blockDaaScore: '101',
      txHash: 't2',
      outputIndex: 1,
      detectorKind: 'KCC20Asset',
      covenantId: '0xdef',
      payload: { controller: 'k2' },
    },
  ];

  private readonly lineageStore: Record<string, CovenantLineage> = {
    '0xabc': {
      covenantId: '0xabc',
      genesisTx: 'gen',
      currentUtxo: 't1:0',
      lineageCount: 2,
      lastSeenDaa: '101',
      entries: [
        { seq: 0, txHash: 'gen', outputIndex: 0, daaScore: '99' },
        { seq: 1, txHash: 't1', outputIndex: 0, daaScore: '100' },
      ],
    },
  };

  async committedBlock(args: CommittedBlockArgs): Promise<CommittedBlock | null> {
    this.calls.push({ field: 'committedBlock', args });
    return (
      this.committedBlocksStore.find(
        (b) => b.subgraph === args.subgraph && b.blockHash === args.hash,
      ) ?? null
    );
  }

  async committedBlocks(args: CommittedBlocksArgs): Promise<CommittedBlock[]> {
    this.calls.push({ field: 'committedBlocks', args });
    const matched = this.committedBlocksStore.filter((b) => b.subgraph === args.subgraph);
    return matched.slice(0, args.first ?? matched.length);
  }

  async poiCheckpoints(args: PoiCheckpointsArgs): Promise<PoiCheckpoint[]> {
    this.calls.push({ field: 'poiCheckpoints', args });
    const matched = this.poiStore.filter((c) => c.subgraph === args.subgraph);
    return matched.slice(0, args.first ?? matched.length);
  }

  async detectedPatterns(args: DetectedPatternsArgs): Promise<DetectedPattern[]> {
    this.calls.push({ field: 'detectedPatterns', args });
    const matched = this.detectedStore.filter(
      (d) =>
        d.subgraph === args.subgraph &&
        (args.kind === undefined || d.detectorKind === args.kind),
    );
    return matched.slice(0, args.first ?? matched.length);
  }

  async covenantLineage(args: CovenantLineageArgs): Promise<CovenantLineage | null> {
    this.calls.push({ field: 'covenantLineage', args });
    return this.lineageStore[args.covenantId] ?? null;
  }
}

describe('@kasgraph/api — schema surface', () => {
  it('exposes the canonical base SDL with every documented entity', () => {
    for (const expected of [
      'CommittedBlock',
      'PoiCheckpoint',
      'DetectedPattern',
      'CovenantLineage',
      'CovenantLineageEntry',
      'scalar BigInt',
      'scalar JSON',
    ]) {
      expect(KASGRAPH_BASE_SCHEMA_SDL).toContain(expected);
    }
  });

  it('builds an executable schema with the expected query fields', () => {
    const schema = getKasGraphSchema();
    const query = schema.getQueryType();
    expect(query).toBeDefined();
    const fields = Object.keys(query!.getFields());
    expect(fields).toEqual(
      expect.arrayContaining([
        'committedBlock',
        'committedBlocks',
        'poiCheckpoints',
        'detectedPatterns',
        'covenantLineage',
      ]),
    );
  });

  it('introspection round-trip works', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      { query: '{ __schema { queryType { name } } }' },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const queryName = (
      res.data as { __schema: { queryType: { name: string } } } | null | undefined
    )?.__schema.queryType.name;
    expect(queryName).toBe('Query');
  });
});

describe('@kasgraph/api — executeGraphQLQuery', () => {
  it('returns parse errors as a structured errors array', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery({ query: '{ bad' }, resolvers);
    expect(res.errors).toBeDefined();
    expect(res.errors!.length).toBeGreaterThan(0);
  });

  it('returns validation errors for unknown fields', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      { query: '{ notAField }' },
      resolvers,
    );
    expect(res.errors).toBeDefined();
    expect(res.errors!.some((e) => /Cannot query/.test(e.message))).toBe(true);
  });

  it('committedBlocks(subgraph) returns matching rows in store order', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `query Q($s: String!) {
          committedBlocks(subgraph: $s, first: 5) {
            blockHash daaScore servedBy
          }
        }`,
        variables: { s: 'kasbonds' },
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const blocks = (
      res.data as {
        committedBlocks: Array<{ blockHash: string; daaScore: string }>;
      }
    ).committedBlocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.blockHash).toBe('h1');
    expect(blocks[0]!.daaScore).toBe('100');
  });

  it('committedBlock(subgraph, hash) returns null when not found', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `{ committedBlock(subgraph: "kasbonds", hash: "missing") { blockHash } }`,
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    expect((res.data as { committedBlock: unknown }).committedBlock).toBeNull();
  });

  it('detectedPatterns filters by kind when provided', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `{
          detectedPatterns(subgraph: "kasbonds", kind: "OpenSilverVault") {
            detectorKind txHash covenantId
          }
        }`,
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const hits = (
      res.data as {
        detectedPatterns: Array<{ detectorKind: string; covenantId: string | null }>;
      }
    ).detectedPatterns;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.detectorKind).toBe('OpenSilverVault');
    expect(hits[0]!.covenantId).toBe('0xabc');
  });

  it('detectedPatterns omits the kind filter when not provided', async () => {
    const resolvers = new InMemoryResolvers();
    await executeGraphQLQuery(
      {
        query: `{ detectedPatterns(subgraph: "kasbonds") { detectorKind } }`,
      },
      resolvers,
    );
    const lastCall = resolvers.calls.at(-1);
    expect(lastCall?.field).toBe('detectedPatterns');
    // resolver received no `kind` field, not `kind: undefined`
    const args = lastCall?.args as Record<string, unknown>;
    expect('kind' in args).toBe(false);
  });

  it('detectedPatterns surfaces the JSON payload through the JSON scalar', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `{ detectedPatterns(subgraph: "kasbonds") { detectorKind payload } }`,
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const hits = (
      res.data as {
        detectedPatterns: Array<{ detectorKind: string; payload: unknown }>;
      }
    ).detectedPatterns;
    const vault = hits.find((h) => h.detectorKind === 'OpenSilverVault')!;
    expect(vault.payload).toMatchObject({ owner: 'k1' });
  });

  it('covenantLineage returns the walk for a known id', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `{
          covenantLineage(covenantId: "0xabc") {
            covenantId lineageCount entries { seq txHash daaScore }
          }
        }`,
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const lineage = (
      res.data as { covenantLineage: { covenantId: string; lineageCount: number; entries: unknown[] } }
    ).covenantLineage;
    expect(lineage.covenantId).toBe('0xabc');
    expect(lineage.lineageCount).toBe(2);
    expect(lineage.entries).toHaveLength(2);
  });

  it('covenantLineage returns null for an unknown id', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      { query: `{ covenantLineage(covenantId: "nope") { covenantId } }` },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    expect(
      (res.data as { covenantLineage: unknown }).covenantLineage,
    ).toBeNull();
  });

  it('BigInt scalar serialises DAA scores as decimal strings', async () => {
    const resolvers = new InMemoryResolvers();
    const res = await executeGraphQLQuery(
      {
        query: `{
          poiCheckpoints(subgraph: "kasbonds") { blockDaaScore poiHashHex }
        }`,
      },
      resolvers,
    );
    expect(res.errors).toBeUndefined();
    const cps = (
      res.data as {
        poiCheckpoints: Array<{ blockDaaScore: unknown; poiHashHex: string }>;
      }
    ).poiCheckpoints;
    for (const cp of cps) {
      expect(typeof cp.blockDaaScore).toBe('string');
    }
  });
});
