'use client';

import { useState } from 'react';
import { CodeBlock } from '@/components/CodeBlock';

const starterQueries = [
  {
    label: 'Latest POI checkpoints',
    query: `query LatestPoiCheckpoints {
  poiCheckpoints(subgraph: "network-stats", first: 5) {
    subgraph
    blockDaaScore
    poiHashHex
  }
}`,
  },
  {
    label: 'Latest indexed DAA',
    query: `query LatestIndexedDaa {
  committedBlocks(first: 5, orderBy: daaScore, orderDirection: desc) {
    subgraph
    daaScore
    blockHash
    committedAt
  }
}`,
  },
  {
    label: 'Committed blocks',
    query: `query CommittedBlocks {
  committedBlocks(first: 10, orderBy: daaScore, orderDirection: desc) {
    subgraph
    blockHash
    daaScore
    servedBy
    committedAt
  }
}`,
  },
  {
    label: 'Detected patterns',
    query: `query DetectedPatterns {
  detectedPatterns(first: 10) {
    subgraph
    blockDaaScore
    detectorKind
    covenantId
    txHash
  }
}`,
  },
  {
    label: 'Covenant lineage',
    query: `query CovenantLineage($covenantId: String!) {
  covenantLineage(covenantId: $covenantId) {
    covenantId
    lineageCount
    currentUtxo
  }
}`,
  },
  {
    label: 'KRC-20 entities',
    query: `query Krc20Tokens {
  entities(subgraph: "krc20", entity: "Token", first: 10) {
    id
    data
    blockDaaScore
  }
}`,
  },
  {
    label: 'KRC-721 entities',
    query: `query Krc721Collections {
  entities(subgraph: "krc721", entity: "Collection", first: 10) {
    id
    data
    blockDaaScore
  }
}`,
  },
  {
    label: 'Generic entity query',
    query: `query GenericEntities($subgraph: String!, $entity: String!) {
  entities(subgraph: $subgraph, entity: $entity, first: 10) {
    id
    data
    blockDaaScore
  }
}`,
  },
];

type PlaygroundClientProps = {
  graphqlUrl: string;
  statusUrl: string;
};

export function PlaygroundClient({ graphqlUrl, statusUrl }: Readonly<PlaygroundClientProps>) {
  const [query, setQuery] = useState(starterQueries[0]?.query ?? '');
  const [result, setResult] = useState('No query has been executed in this browser session.');
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (graphqlUrl.length === 0) {
    return (
      <section className="section">
        <div className="panel rounded-lg p-7">
          <p className="leading-7 text-[#b7c9c5]">
            No fake endpoint is exposed here. Until the hosted API is live, use the local quickstart
            and run `kasgraph-api` against your own Postgres-backed node.
          </p>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {starterQueries.map((item) => (
              <CodeBlock code={item.query} key={item.label} title={item.label} />
            ))}
          </div>
        </div>
      </section>
    );
  }

  async function runQuery(): Promise<void> {
    setIsRunning(true);
    setError(null);
    try {
      const res = await fetch(graphqlUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      const text = await res.text();
      const formatted = text.length > 0 ? JSON.stringify(JSON.parse(text), null, 2) : '';
      setResult(formatted);
      if (!res.ok) {
        setError(`GraphQL endpoint returned HTTP ${res.status}.`);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setResult('Request failed. Check endpoint health, CORS, and query support.');
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <section className="section grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="panel rounded-lg p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mono text-xs uppercase tracking-[0.22em] text-[#49EACB]">public GraphQL</p>
            <h2 className="mt-3 text-2xl font-semibold text-[#f3fffc]">Live-aware playground</h2>
          </div>
          <span className="mono rounded-full border border-[#49EACB]/35 px-3 py-1 text-xs uppercase tracking-[0.16em] text-[#49EACB]">
            Testnet if status is healthy
          </span>
        </div>
        <p className="mt-4 text-sm leading-6 text-[#a9bbb7]">
          Endpoint: <span className="break-all text-[#dffcf6]">{graphqlUrl}</span>
        </p>
        {statusUrl.length > 0 ? (
          <p className="mt-2 text-sm leading-6 text-[#a9bbb7]">
            Status: <span className="break-all text-[#dffcf6]">{statusUrl}</span>
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2">
          {starterQueries.map((item) => (
            <button
              className="rounded-md border border-[#70C7BA]/22 px-3 py-2 text-sm text-[#dffcf6] transition hover:border-[#49EACB]/50"
              key={item.label}
              onClick={() => setQuery(item.query)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
        <textarea
          className="mono mt-5 min-h-80 w-full rounded-lg border border-[#70C7BA]/22 bg-black/50 p-4 text-sm leading-6 text-[#d8fff7] outline-none focus:border-[#49EACB]/55"
          onChange={(event) => setQuery(event.target.value)}
          spellCheck={false}
          value={query}
        />
        <button
          className="mt-4 rounded-md bg-[#49EACB] px-5 py-3 text-sm font-semibold text-[#021110] disabled:cursor-not-allowed disabled:opacity-60"
          disabled={isRunning}
          onClick={() => void runQuery()}
          type="button"
        >
          {isRunning ? 'Running...' : 'Run query'}
        </button>
        {error ? <p className="mt-4 text-sm leading-6 text-[#ffb4a8]">{error}</p> : null}
      </div>
      <CodeBlock code={result} title="response" />
    </section>
  );
}
