// Subscription source contract + in-memory impl.
//
// `SubscriptionSource` is the bridge between an event producer
// (today: the indexer's in-process StreamHub via a future
// Postgres LISTEN/NOTIFY adapter; tests: `InMemorySubscriptionSource`)
// and the GraphQL gateway's `Subscription.detectedPatterns`
// resolver.
//
// Filter semantics (AND across the three keys; undefined keys
// match anything):
//   subgraph    — matches event.subgraph
//   kind        — matches event.detectorKind
//   covenantId  — matches event.covenantId (treats event with
//                 covenantId=null as a non-match when the filter
//                 supplies one).

import type { DetectedPattern } from './index.js';

export interface DetectedPatternsFilter {
  subgraph?: string;
  kind?: string;
  covenantId?: string;
}

export interface SubscriptionSource {
  /**
   * Stream events matching `filter`. Consumers may stop the
   * stream by `break`ing out of the `for await` loop or calling
   * `return()` on the returned iterator — the source must
   * release any internal resources (channel slots, listeners,
   * etc.) when that happens.
   */
  subscribeDetectedPatterns(
    filter: DetectedPatternsFilter,
  ): AsyncIterable<DetectedPattern>;
}

/**
 * Process-local pub/sub. Producers call `publish(event)`; every
 * subscriber whose filter matches receives the event in publish
 * order. A subscriber that doesn't consume fast enough applies
 * back-pressure to the publisher via an internal queue with an
 * unbounded length — operators bounded by message-rate constraints
 * should switch to the Postgres LISTEN/NOTIFY impl which has a
 * natural buffering ceiling.
 */
export class InMemorySubscriptionSource implements SubscriptionSource {
  private readonly subscribers = new Set<InMemorySubscriber>();

  publish(event: DetectedPattern): void {
    for (const sub of this.subscribers) {
      if (matches(event, sub.filter)) {
        sub.push(event);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }

  subscribeDetectedPatterns(
    filter: DetectedPatternsFilter,
  ): AsyncIterable<DetectedPattern> {
    const subscriber = new InMemorySubscriber(filter, () => {
      this.subscribers.delete(subscriber);
    });
    this.subscribers.add(subscriber);
    return subscriber;
  }
}

/**
 * One subscriber's view of the stream. Lazy AsyncIterable: each
 * `next()` either resolves an already-queued event or returns a
 * pending promise that the next `push` resolves.
 */
class InMemorySubscriber implements AsyncIterable<DetectedPattern>, AsyncIterator<DetectedPattern> {
  private readonly queue: DetectedPattern[] = [];
  private pending: ((value: IteratorResult<DetectedPattern>) => void) | null = null;
  private closed = false;

  constructor(
    public readonly filter: DetectedPatternsFilter,
    private readonly onClose: () => void,
  ) {}

  push(event: DetectedPattern): void {
    if (this.closed) return;
    if (this.pending !== null) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: event, done: false });
      return;
    }
    this.queue.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<DetectedPattern> {
    return this;
  }

  next(): Promise<IteratorResult<DetectedPattern>> {
    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    const queued = this.queue.shift();
    if (queued !== undefined) {
      return Promise.resolve({ value: queued, done: false });
    }
    return new Promise<IteratorResult<DetectedPattern>>((resolve) => {
      this.pending = resolve;
    });
  }

  return(): Promise<IteratorResult<DetectedPattern>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  throw(err: unknown): Promise<IteratorResult<DetectedPattern>> {
    this.close();
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending !== null) {
      const resolve = this.pending;
      this.pending = null;
      resolve({ value: undefined, done: true });
    }
    this.onClose();
  }
}

/**
 * Exposed so tests + other sources (a future PgListenSource)
 * can reuse the same filter rules the in-memory source applies.
 */
export function matches(
  event: DetectedPattern,
  filter: DetectedPatternsFilter,
): boolean {
  if (filter.subgraph !== undefined && event.subgraph !== filter.subgraph) {
    return false;
  }
  if (filter.kind !== undefined && event.detectorKind !== filter.kind) {
    return false;
  }
  if (filter.covenantId !== undefined && event.covenantId !== filter.covenantId) {
    return false;
  }
  return true;
}
