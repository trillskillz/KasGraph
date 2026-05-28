import { describe, expect, it } from 'vitest';
import {
  DETECTED_PATTERN_CHANNEL,
  PgListenSource,
  type DetectedPattern,
  type PgListenClient,
  type PgNotificationMessage,
} from '../api/src/index.js';

class FakeListenClient implements PgListenClient {
  readonly queries: string[] = [];
  connectCount = 0;
  ended = false;
  errorListener: ((err: Error) => void) | undefined;
  notificationListener: ((msg: PgNotificationMessage) => void) | undefined;

  // eslint-disable-next-line @typescript-eslint/require-await
  async connect(): Promise<void> {
    this.connectCount += 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    return undefined;
  }

  on(event: 'notification', listener: (msg: PgNotificationMessage) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'notification' | 'error', listener: (...args: unknown[]) => void): void {
    if (event === 'notification') {
      this.notificationListener = listener as (msg: PgNotificationMessage) => void;
    } else if (event === 'error') {
      this.errorListener = listener as (err: Error) => void;
    }
  }

  removeAllListeners(event?: 'notification' | 'error'): void {
    if (event === undefined || event === 'notification') this.notificationListener = undefined;
    if (event === undefined || event === 'error') this.errorListener = undefined;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async end(): Promise<void> {
    this.ended = true;
  }

  // Test helper.
  emit(payload: unknown, channel: string = DETECTED_PATTERN_CHANNEL): void {
    if (this.notificationListener === undefined) {
      throw new Error('no notification listener registered yet');
    }
    this.notificationListener({
      channel,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    });
  }
}

function newSource(client: FakeListenClient): PgListenSource {
  return new PgListenSource({
    connect: async () => Promise.resolve(client),
    // Silence unexpected stderr noise in this test suite.
    onError: () => {
      /* drop */
    },
  });
}

async function awaitTick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function validPayload(): Record<string, unknown> {
  return {
    subgraph: 'kasbonds',
    blockHash: 'h1',
    blockDaaScore: '100',
    txHash: 't1',
    outputIndex: 0,
    detectorKind: 'OpenSilverVault',
    covenantId: '0xabc',
    payload: { owner: 'k1' },
  };
}

describe('PgListenSource — connection lifecycle', () => {
  it('connects + LISTENs lazily on first subscribe', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    expect(client.connectCount).toBe(0);
    expect(client.queries).toEqual([]);

    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    expect(client.connectCount).toBe(1);
    expect(client.queries).toEqual([`LISTEN ${DETECTED_PATTERN_CHANNEL}`]);

    if (iter.return !== undefined) await iter.return();
  });

  it('multiple subscribers share one LISTEN call', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const a = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    const b = src.subscribeDetectedPatterns({ subgraph: 'kasbonds' })[Symbol.asyncIterator]();
    await awaitTick();
    expect(client.connectCount).toBe(1);
    expect(client.queries.filter((q) => q.startsWith('LISTEN'))).toHaveLength(1);

    if (a.return !== undefined) await a.return();
    if (b.return !== undefined) await b.return();
  });

  it('UNLISTENs + ends when the last subscriber drops', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();
    expect(client.ended).toBe(false);
    if (iter.return !== undefined) await iter.return();
    expect(client.ended).toBe(true);
    expect(client.queries.at(-1)).toBe(`UNLISTEN ${DETECTED_PATTERN_CHANNEL}`);
    expect(src.subscriberCount()).toBe(0);
  });

  it('keeps the connection alive while at least one subscriber remains', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const a = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    const b = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();
    if (a.return !== undefined) await a.return();
    expect(client.ended).toBe(false);
    if (b.return !== undefined) await b.return();
    expect(client.ended).toBe(true);
  });
});

describe('PgListenSource — payload routing', () => {
  it('publishes a parsed payload to matching subscribers in publish order', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({ subgraph: 'kasbonds' })[Symbol.asyncIterator]();
    await awaitTick();

    client.emit({ ...validPayload(), txHash: 't1' });
    client.emit({ ...validPayload(), subgraph: 'other', txHash: 't2' });
    client.emit({ ...validPayload(), txHash: 't3' });

    const a = await iter.next();
    const b = await iter.next();
    expect(a.value?.txHash).toBe('t1');
    expect(b.value?.txHash).toBe('t3');

    if (iter.return !== undefined) await iter.return();
  });

  it('normalises optional fields (omits covenantId/payload when null)', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    client.emit({
      subgraph: 'k',
      blockHash: 'h',
      blockDaaScore: '1',
      txHash: 't',
      outputIndex: 0,
      detectorKind: 'OpenSilverVault',
      covenantId: null,
      payload: null,
    });

    const res = await iter.next();
    const ev = res.value as DetectedPattern;
    expect('covenantId' in ev).toBe(false);
    expect('payload' in ev).toBe(false);

    if (iter.return !== undefined) await iter.return();
  });

  it('drops a payload that is missing a required field', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    // Missing detectorKind — should be silently dropped.
    client.emit({
      subgraph: 'k',
      blockHash: 'h',
      blockDaaScore: '1',
      txHash: 't',
      outputIndex: 0,
    });

    // Now emit a valid one and confirm the subscriber sees only the
    // valid event (not the dropped one).
    client.emit(validPayload());

    const res = await iter.next();
    const ev = res.value as DetectedPattern;
    expect(ev.detectorKind).toBe('OpenSilverVault');

    if (iter.return !== undefined) await iter.return();
  });

  it('drops a notification with no payload', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    if (client.notificationListener === undefined) throw new Error('listener missing');
    client.notificationListener({ channel: DETECTED_PATTERN_CHANNEL });

    client.emit(validPayload());
    const res = await iter.next();
    expect((res.value as DetectedPattern).txHash).toBe('t1');

    if (iter.return !== undefined) await iter.return();
  });

  it('drops a notification on a different channel', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    client.emit(validPayload(), 'unrelated_channel');
    client.emit(validPayload(), DETECTED_PATTERN_CHANNEL);

    const res = await iter.next();
    expect((res.value as DetectedPattern).txHash).toBe('t1');

    if (iter.return !== undefined) await iter.return();
  });

  it('drops a malformed-JSON payload without crashing', async () => {
    let errored = false;
    const client = new FakeListenClient();
    const src = new PgListenSource({
      connect: async () => Promise.resolve(client),
      onError: () => {
        errored = true;
      },
    });
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();

    if (client.notificationListener === undefined) throw new Error('listener missing');
    client.notificationListener({
      channel: DETECTED_PATTERN_CHANNEL,
      payload: 'not-json{',
    });
    expect(errored).toBe(true);

    // Subscriber is still usable.
    client.emit(validPayload());
    const res = await iter.next();
    expect((res.value as DetectedPattern).txHash).toBe('t1');

    if (iter.return !== undefined) await iter.return();
  });
});

describe('PgListenSource — close()', () => {
  it('UNLISTENs + ends the client even with active subscribers', async () => {
    const client = new FakeListenClient();
    const src = newSource(client);
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();
    await src.close();
    expect(client.ended).toBe(true);
    expect(client.queries.at(-1)).toBe(`UNLISTEN ${DETECTED_PATTERN_CHANNEL}`);
    // Iterator hasn't been returned; it'll just stop receiving
    // events. The next iterator.return() is harmless.
    if (iter.return !== undefined) await iter.return();
  });

  it('lazy-reconnects when a new subscriber arrives after close()', async () => {
    const clients: FakeListenClient[] = [new FakeListenClient(), new FakeListenClient()];
    let n = 0;
    const src = new PgListenSource({
      connect: async () => {
        const c = clients[n];
        n += 1;
        if (c === undefined) throw new Error('out of canned clients');
        return c;
      },
      onError: () => {
        /* drop */
      },
    });

    const a = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();
    expect(clients[0]!.connectCount).toBe(1);
    if (a.return !== undefined) await a.return();
    expect(clients[0]!.ended).toBe(true);

    const b = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    await awaitTick();
    expect(clients[1]!.connectCount).toBe(1);
    if (b.return !== undefined) await b.return();
  });
});
