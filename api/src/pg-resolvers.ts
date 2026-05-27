// Postgres-backed implementation of `GatewayResolvers`.
//
// Targets the Phase 2.4 + 2.5 schema in `crates/kasgraph-store/migrations/`:
//
//   kasgraph_committed_block (subgraph, block_hash, daa_score, served_by, committed_at)
//   kasgraph_poi             (subgraph, block_daa_score, poi_hash)
//   kasgraph_detected_pattern(subgraph, block_hash, block_daa_score,
//                             tx_hash, output_index, detector_kind,
//                             covenant_id, payload, detected_at)
//   kasgraph_covenant_lineage_head (covenant_id, genesis_tx, current_utxo,
//                                   last_seen_daa, lineage_count)
//   kasgraph_covenant_lineage_row  (covenant_id, seq, tx_hash, output_index,
//                                   state_bytes, daa_score)
//
// The implementation is constructed against a minimal `PgPoolLike`
// interface so tests can mock the pool without standing up
// Postgres. Production code passes a real `pg.Pool`.

import type {
  CommittedBlock,
  CommittedBlockArgs,
  CommittedBlocksArgs,
  CovenantLineage,
  CovenantLineageArgs,
  CovenantLineageEntry,
  DetectedPattern,
  DetectedPatternsArgs,
  GatewayResolvers,
  PoiCheckpoint,
  PoiCheckpointsArgs,
} from './index.js';

/**
 * The subset of `pg.Pool#query` this module needs. `pg.Pool`
 * itself satisfies this; tests pass a mock that records calls and
 * returns canned rows.
 */
export interface PgPoolLike {
  query<TRow extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>>;
}

export type QueryResultRow = Record<string, unknown>;

export interface QueryResult<TRow extends QueryResultRow> {
  rows: TRow[];
}

const DEFAULT_FIRST = 50;
const MAX_FIRST = 1000;

function boundedFirst(n: number | undefined): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.trunc(n) : DEFAULT_FIRST;
  if (v <= 0) return DEFAULT_FIRST;
  return v > MAX_FIRST ? MAX_FIRST : v;
}

function bigIntString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'bigint') return value.toString();
  // node-postgres returns BIGINT as a string by default; the
  // belt-and-suspenders branches above cover non-default pg type
  // parsers without forcing the caller to configure them.
  return String(value);
}

function isoString(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(0).toISOString();
}

function hexFromBytes(value: unknown): string {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (Buffer.isBuffer(value)) {
    return value.toString('hex');
  }
  if (typeof value === 'string') return value;
  return '';
}

interface CommittedBlockRow extends QueryResultRow {
  subgraph: string;
  block_hash: string;
  daa_score: unknown;
  served_by: string;
  committed_at: unknown;
}

interface PoiRow extends QueryResultRow {
  subgraph: string;
  block_daa_score: unknown;
  poi_hash: unknown;
}

interface DetectedPatternRow extends QueryResultRow {
  subgraph: string;
  block_hash: string;
  block_daa_score: unknown;
  tx_hash: string;
  output_index: number;
  detector_kind: string;
  covenant_id: string | null;
  payload: unknown;
}

interface LineageHeadRow extends QueryResultRow {
  covenant_id: string;
  genesis_tx: string;
  current_utxo: string;
  last_seen_daa: unknown;
  lineage_count: number;
}

interface LineageEntryRow extends QueryResultRow {
  seq: number;
  tx_hash: string;
  output_index: number;
  daa_score: unknown;
  state_bytes: unknown;
}

function rowToCommittedBlock(row: CommittedBlockRow): CommittedBlock {
  return {
    subgraph: row.subgraph,
    blockHash: row.block_hash,
    daaScore: bigIntString(row.daa_score),
    servedBy: row.served_by,
    committedAt: isoString(row.committed_at),
  };
}

function rowToPoi(row: PoiRow): PoiCheckpoint {
  return {
    subgraph: row.subgraph,
    blockDaaScore: bigIntString(row.block_daa_score),
    poiHashHex: hexFromBytes(row.poi_hash),
  };
}

function rowToDetectedPattern(row: DetectedPatternRow): DetectedPattern {
  const payload =
    row.payload === null || row.payload === undefined
      ? undefined
      : (row.payload as Record<string, unknown>);
  const covenantId = row.covenant_id ?? undefined;
  return {
    subgraph: row.subgraph,
    blockHash: row.block_hash,
    blockDaaScore: bigIntString(row.block_daa_score),
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    detectorKind: row.detector_kind,
    ...(covenantId !== undefined && { covenantId }),
    ...(payload !== undefined && { payload }),
  };
}

function rowToLineageEntry(row: LineageEntryRow): CovenantLineageEntry {
  const stateBytesHex = hexFromBytes(row.state_bytes);
  return {
    seq: row.seq,
    txHash: row.tx_hash,
    outputIndex: row.output_index,
    daaScore: bigIntString(row.daa_score),
    ...(stateBytesHex.length > 0 && { stateBytesHex }),
  };
}

export class PgGatewayResolvers implements GatewayResolvers {
  constructor(private readonly pool: PgPoolLike) {}

  async committedBlock(args: CommittedBlockArgs): Promise<CommittedBlock | null> {
    const result = await this.pool.query<CommittedBlockRow>(
      `SELECT subgraph, block_hash, daa_score, served_by, committed_at
       FROM kasgraph_committed_block
       WHERE subgraph = $1 AND block_hash = $2
       LIMIT 1`,
      [args.subgraph, args.hash],
    );
    const row = result.rows[0];
    return row !== undefined ? rowToCommittedBlock(row) : null;
  }

  async committedBlocks(args: CommittedBlocksArgs): Promise<CommittedBlock[]> {
    const limit = boundedFirst(args.first);
    const result = await this.pool.query<CommittedBlockRow>(
      `SELECT subgraph, block_hash, daa_score, served_by, committed_at
       FROM kasgraph_committed_block
       WHERE subgraph = $1
       ORDER BY daa_score DESC
       LIMIT $2`,
      [args.subgraph, limit],
    );
    return result.rows.map(rowToCommittedBlock);
  }

  async poiCheckpoints(args: PoiCheckpointsArgs): Promise<PoiCheckpoint[]> {
    const limit = boundedFirst(args.first);
    const clauses = ['subgraph = $1'];
    const values: unknown[] = [args.subgraph];
    if (args.fromDaa !== undefined) {
      values.push(args.fromDaa);
      clauses.push(`block_daa_score >= $${values.length}`);
    }
    if (args.toDaa !== undefined) {
      values.push(args.toDaa);
      clauses.push(`block_daa_score <= $${values.length}`);
    }
    values.push(limit);
    const result = await this.pool.query<PoiRow>(
      `SELECT subgraph, block_daa_score, poi_hash
       FROM kasgraph_poi
       WHERE ${clauses.join(' AND ')}
       ORDER BY block_daa_score DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(rowToPoi);
  }

  async detectedPatterns(args: DetectedPatternsArgs): Promise<DetectedPattern[]> {
    const limit = boundedFirst(args.first);
    const clauses = ['subgraph = $1'];
    const values: unknown[] = [args.subgraph];
    if (args.kind !== undefined) {
      values.push(args.kind);
      clauses.push(`detector_kind = $${values.length}`);
    }
    values.push(limit);
    const result = await this.pool.query<DetectedPatternRow>(
      `SELECT subgraph, block_hash, block_daa_score, tx_hash, output_index,
              detector_kind, covenant_id, payload
       FROM kasgraph_detected_pattern
       WHERE ${clauses.join(' AND ')}
       ORDER BY block_daa_score DESC, tx_hash, output_index
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(rowToDetectedPattern);
  }

  async covenantLineage(
    args: CovenantLineageArgs,
  ): Promise<CovenantLineage | null> {
    const headResult = await this.pool.query<LineageHeadRow>(
      `SELECT covenant_id, genesis_tx, current_utxo, last_seen_daa, lineage_count
       FROM kasgraph_covenant_lineage_head
       WHERE covenant_id = $1
       LIMIT 1`,
      [args.covenantId],
    );
    const head = headResult.rows[0];
    if (head === undefined) return null;

    const rowsResult = await this.pool.query<LineageEntryRow>(
      `SELECT seq, tx_hash, output_index, daa_score, state_bytes
       FROM kasgraph_covenant_lineage_row
       WHERE covenant_id = $1
       ORDER BY seq ASC`,
      [args.covenantId],
    );

    return {
      covenantId: head.covenant_id,
      genesisTx: head.genesis_tx,
      currentUtxo: head.current_utxo,
      lineageCount: head.lineage_count,
      lastSeenDaa: bigIntString(head.last_seen_daa),
      entries: rowsResult.rows.map(rowToLineageEntry),
    };
  }
}
