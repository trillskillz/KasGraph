import { describe, expect, it } from 'vitest';
import {
  createKasGraphServer,
  detectedPatternsFilterMatches,
  InMemorySubscriptionSource,
  type DetectedPattern,
  type GatewayResolvers,
  type PgPoolLike,
  type QueryResult,
  type QueryResultRow,
} from '../api/src/index.js';

class StubPool implements PgPoolLike {
  async query<TRow extends QueryResultRow = QueryResultRow>(
    _text: string,
    _values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<TRow>> {
    return { rows: [] as TRow[] };
  }
}

class EmptyResolvers implements GatewayResolvers {
  async committedBlock() {
    return null;
  }
  async committedBlocks() {
    return [];
  }
  async poiCheckpoints() {
    return [];
  }
  async detectedPatterns() {
    return [];
  }
  async covenantLineage() {
    return null;
  }
}

function hit(partial: Partial<DetectedPattern>): DetectedPattern {
  return {
    subgraph: 'kasbonds',
    blockHash: 'h1',
    blockDaaScore: '100',
    txHash: 't1',
    outputIndex: 0,
    detectorKind: 'OpenSilverVault',
    ...partial,
  };
}

describe('detectedPatternsFilterMatches', () => {
  it('matches everything when the filter is empty', () => {
    expect(detectedPatternsFilterMatches(hit({}), {})).toBe(true);
  });

  it('filters by subgraph (AND)', () => {
    expect(
      detectedPatternsFilterMatches(hit({ subgraph: 'k' }), { subgraph: 'k' }),
    ).toBe(true);
    expect(
      detectedPatternsFilterMatches(hit({ subgraph: 'other' }), { subgraph: 'k' }),
    ).toBe(false);
  });

  it('filters by detectorKind via the `kind` key', () => {
    expect(
      detectedPatternsFilterMatches(hit({ detectorKind: 'KCC20Asset' }), {
        kind: 'KCC20Asset',
      }),
    ).toBe(true);
    expect(
      detectedPatternsFilterMatches(hit({ detectorKind: 'KCC20Asset' }), {
        kind: 'OpenSilverVault',
      }),
    ).toBe(false);
  });

  it('treats a hit with no covenantId as a non-match when filter supplies one', () => {
    expect(
      detectedPatternsFilterMatches(hit({}), { covenantId: '0xabc' }),
    ).toBe(false);
    expect(
      detectedPatternsFilterMatches(hit({ covenantId: '0xabc' }), {
        covenantId: '0xabc',
      }),
    ).toBe(true);
  });
});

describe('InMemorySubscriptionSource', () => {
  it('delivers published events to a matching subscriber in order', async () => {
    const src = new InMemorySubscriptionSource();
    const iter = src
      .subscribeDetectedPatterns({ subgraph: 'kasbonds' })
      [Symbol.asyncIterator]();
    src.publish(hit({ subgraph: 'kasbonds', txHash: 't1' }));
    src.publish(hit({ subgraph: 'other', txHash: 't2' }));
    src.publish(hit({ subgraph: 'kasbonds', txHash: 't3' }));

    const a = await iter.next();
    const b = await iter.next();
    expect(a.value?.txHash).toBe('t1');
    expect(b.value?.txHash).toBe('t3');

    if (iter.return !== undefined) {
      await iter.return();
    }
  });

  it('supports awaiting the next event before it is published', async () => {
    const src = new InMemorySubscriptionSource();
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    const pending = iter.next();
    // Publish on the next tick.
    setTimeout(() => src.publish(hit({ txHash: 'later' })), 0);
    const result = await pending;
    expect(result.value?.txHash).toBe('later');
    if (iter.return !== undefined) {
      await iter.return();
    }
  });

  it('drops a subscriber from the set when its iterator is returned', async () => {
    const src = new InMemorySubscriptionSource();
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    expect(src.subscriberCount()).toBe(1);
    if (iter.return !== undefined) {
      const done = await iter.return();
      expect(done.done).toBe(true);
    }
    expect(src.subscriberCount()).toBe(0);
  });

  it('a pending iterator resolves with done=true on return()', async () => {
    const src = new InMemorySubscriptionSource();
    const iter = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    const pending = iter.next();
    if (iter.return !== undefined) {
      await iter.return();
    }
    const result = await pending;
    expect(result.done).toBe(true);
  });

  it('fan-out: every subscriber whose filter matches receives the event', async () => {
    const src = new InMemorySubscriptionSource();
    const all = src.subscribeDetectedPatterns({})[Symbol.asyncIterator]();
    const kBonds = src
      .subscribeDetectedPatterns({ subgraph: 'kasbonds' })
      [Symbol.asyncIterator]();
    const kPatterns = src
      .subscribeDetectedPatterns({ subgraph: 'opensilver_patterns' })
      [Symbol.asyncIterator]();

    src.publish(hit({ subgraph: 'kasbonds', txHash: 'one' }));

    const a = await all.next();
    const b = await kBonds.next();
    expect(a.value?.txHash).toBe('one');
    expect(b.value?.txHash).toBe('one');
    // opensilver_patterns gets nothing — but to assert that
    // without hanging, race the next() against a short timer.
    const fastReturn = await Promise.race([
      kPatterns.next().then((r) => ({ tag: 'next' as const, r })),
      new Promise<{ tag: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ tag: 'timeout' }), 25),
      ),
    ]);
    expect(fastReturn.tag).toBe('timeout');

    if (all.return !== undefined) await all.return();
    if (kBonds.return !== undefined) await kBonds.return();
    if (kPatterns.return !== undefined) await kPatterns.return();
  });
});

describe('createKasGraphServer subscription wiring', () => {
  it('Subscription field appears in the schema', async () => {
    const src = new InMemorySubscriptionSource();
    const yoga = createKasGraphServer({
      pool: new StubPool(),
      resolvers: new EmptyResolvers(),
      subscriptionSource: src,
    });
    const res = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql-response+json, application/json',
      },
      body: JSON.stringify({
        query: '{ __schema { subscriptionType { name } } }',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { __schema: { subscriptionType: { name: string } } };
    };
    expect(body.data.__schema.subscriptionType.name).toBe('Subscription');
  });

  it('subscribing without a configured source surfaces a clear error', async () => {
    const yoga = createKasGraphServer({
      pool: new StubPool(),
      resolvers: new EmptyResolvers(),
      // No subscriptionSource — the field rejects every subscribe.
    });
    const res = await yoga.fetch('http://localhost/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/graphql-response+json, application/json',
      },
      body: JSON.stringify({
        query: `subscription { detectedPatterns { txHash } }`,
      }),
    });
    // Yoga returns a body with errors[] when the subscribe
    // resolver throws synchronously; status may be 200 or 400
    // depending on whether the GraphQL-over-HTTP spec applies.
    expect([200, 400, 500]).toContain(res.status);
    const body = (await res.json()) as { errors?: Array<{ message: string }> };
    expect(body.errors).toBeDefined();
    expect(body.errors!.some((e) => /subscriptions are not configured/.test(e.message))).toBe(
      true,
    );
  });
});
