// Postgres LISTEN/NOTIFY-backed `SubscriptionSource`.
//
// Pairs with the `kasgraph_detected_pattern_notify_trg` trigger
// (see crates/kasgraph-store/migrations/20260528120000_detector_hits_notify.sql).
// Every insert into `kasgraph_detected_pattern` fires a
// `pg_notify('kasgraph_detected_pattern', json_payload)`; we
// LISTEN on that channel and route the payloads to matching
// GraphQL subscribers.
//
// LISTEN requires a dedicated long-lived client, not a pooled
// connection — `pg.Pool#query('LISTEN ...')` checks the connection
// out, runs LISTEN, then returns it to the pool, dropping any
// future notifications on the floor. So this source asks the
// caller for a `connect()` factory that returns a fresh, dedicated
// client.

import {
  InMemorySubscriptionSource,
  type DetectedPatternsFilter,
  type SubscriptionSource,
} from './subscriptions.js';
import type { DetectedPattern } from './index.js';

export const DETECTED_PATTERN_CHANNEL = 'kasgraph_detected_pattern';

/**
 * The subset of `pg.Client` that `PgListenSource` calls.
 * Production passes a real `new pg.Client(connectionString)`;
 * tests pass a recording fake.
 */
export interface PgListenClient {
  connect(): Promise<void>;
  query(text: string): Promise<unknown>;
  on(event: 'notification', listener: (msg: PgNotificationMessage) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  removeAllListeners(event?: 'notification' | 'error'): void;
  end(): Promise<void>;
}

export interface PgNotificationMessage {
  channel: string;
  payload?: string | undefined;
}

export interface PgListenSourceOptions {
  /**
   * Factory that returns a brand-new dedicated client (not a
   * pooled one). Called the first time a subscriber connects;
   * called again after the previous client is `end()`ed if a
   * new subscriber connects later.
   */
  connect: () => Promise<PgListenClient>;
  /**
   * Channel name to LISTEN on. Defaults to
   * `kasgraph_detected_pattern` — matches the migration.
   */
  channel?: string;
  /**
   * Hook for diagnostic logging of malformed payloads or
   * connection errors. Defaults to writing to console.error
   * with a stable prefix.
   */
  onError?: (message: string, err?: unknown) => void;
}

/**
 * GraphQL Subscription event source backed by Postgres
 * LISTEN/NOTIFY. Multiplexes one long-lived listener client
 * across every active GraphQL subscriber via an internal
 * `InMemorySubscriptionSource` for filter fan-out.
 */
export class PgListenSource implements SubscriptionSource {
  private readonly bus = new InMemorySubscriptionSource();
  private client: PgListenClient | null = null;
  private connectPromise: Promise<void> | null = null;

  constructor(private readonly options: PgListenSourceOptions) {}

  subscribeDetectedPatterns(
    filter: DetectedPatternsFilter,
  ): AsyncIterable<DetectedPattern> {
    // Kick off lazy connect, but don't await it — the
    // AsyncIterable can be returned synchronously. If the connect
    // fails, the resulting error surfaces via the configured
    // onError hook and the subscriber sees no events (it can
    // tear itself down via iterator.return()).
    void this.ensureConnected();
    const inner = this.bus.subscribeDetectedPatterns(filter);
    return this.wrapWithTeardown(inner);
  }

  /**
   * Number of GraphQL subscribers currently attached. Exposed
   * mostly for tests + introspection — production code shouldn't
   * branch on this.
   */
  subscriberCount(): number {
    return this.bus.subscriberCount();
  }

  /**
   * Force-close the listener client. Subsequent subscribes will
   * lazy-reconnect via the `connect` factory. Intended for
   * graceful shutdown.
   */
  async close(): Promise<void> {
    if (this.client === null) return;
    const client = this.client;
    this.client = null;
    this.connectPromise = null;
    try {
      client.removeAllListeners();
    } catch {
      /* ignore */
    }
    try {
      await client.query(`UNLISTEN ${this.channelName()}`);
    } catch (err) {
      this.options.onError?.('UNLISTEN failed', err);
    }
    try {
      await client.end();
    } catch (err) {
      this.options.onError?.('client.end() failed', err);
    }
  }

  // -----------------------------------------------------------
  // Internals
  // -----------------------------------------------------------

  private channelName(): string {
    return this.options.channel ?? DETECTED_PATTERN_CHANNEL;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client !== null) return;
    if (this.connectPromise !== null) return this.connectPromise;
    this.connectPromise = (async () => {
      try {
        const client = await this.options.connect();
        await client.connect();
        client.on('notification', (msg) => this.handleNotification(msg));
        client.on('error', (err) => {
          this.errorReporter()('listener client error', err);
        });
        await client.query(`LISTEN ${this.channelName()}`);
        this.client = client;
      } catch (err) {
        this.connectPromise = null;
        this.errorReporter()('LISTEN setup failed', err);
        throw err;
      }
    })();
    return this.connectPromise;
  }

  private wrapWithTeardown(
    inner: AsyncIterable<DetectedPattern>,
  ): AsyncIterable<DetectedPattern> {
    const closeIfLast = async (): Promise<void> => {
      if (this.bus.subscriberCount() === 0) {
        await this.close();
      }
    };
    return {
      [Symbol.asyncIterator]: () => {
        const it = inner[Symbol.asyncIterator]();
        return {
          next: () => it.next(),
          return: async (value?: unknown) => {
            const r = it.return !== undefined ? await it.return(value) : { value: undefined, done: true as const };
            await closeIfLast();
            return r as IteratorResult<DetectedPattern>;
          },
          throw: async (err?: unknown) => {
            const r =
              it.throw !== undefined
                ? await it.throw(err)
                : ({ value: undefined, done: true as const } as IteratorResult<DetectedPattern>);
            await closeIfLast();
            return r;
          },
        };
      },
    };
  }

  private handleNotification(msg: PgNotificationMessage): void {
    if (msg.channel !== this.channelName()) return;
    const raw = msg.payload;
    if (raw === undefined || raw.length === 0) return;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const event = normalizePayload(parsed);
      if (event !== null) {
        this.bus.publish(event);
      }
    } catch (err) {
      this.errorReporter()('malformed pg notification payload', err);
    }
  }

  private errorReporter(): (message: string, err?: unknown) => void {
    return (
      this.options.onError ??
      ((message: string, err?: unknown) => {
        const detail = err === undefined ? '' : ` (${err instanceof Error ? err.message : String(err)})`;
        process.stderr.write(`PgListenSource: ${message}${detail}\n`);
      })
    );
  }
}

function normalizePayload(parsed: Record<string, unknown>): DetectedPattern | null {
  // Required fields. Reject the payload (rather than emitting a
  // half-shaped event) when any of them is missing so subscribers
  // never see ill-formed entities.
  const subgraph = strField(parsed, 'subgraph');
  const blockHash = strField(parsed, 'blockHash');
  const blockDaaScore = bigIntStringField(parsed, 'blockDaaScore');
  const txHash = strField(parsed, 'txHash');
  const detectorKind = strField(parsed, 'detectorKind');
  const outputIndex = intField(parsed, 'outputIndex');
  if (
    subgraph === null ||
    blockHash === null ||
    blockDaaScore === null ||
    txHash === null ||
    detectorKind === null ||
    outputIndex === null
  ) {
    return null;
  }

  // Optional fields. Conditional spread keeps undefined out so
  // exactOptionalPropertyTypes downstream stays happy.
  const covenantId = optionalStrField(parsed, 'covenantId');
  const payloadValue = parsed.payload;
  const payloadShaped =
    payloadValue !== null && payloadValue !== undefined && typeof payloadValue === 'object'
      ? (payloadValue as Record<string, unknown>)
      : undefined;
  return {
    subgraph,
    blockHash,
    blockDaaScore,
    txHash,
    outputIndex,
    detectorKind,
    ...(covenantId !== undefined && { covenantId }),
    ...(payloadShaped !== undefined && { payload: payloadShaped }),
  };
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function optionalStrField(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function intField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bigIntStringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}
