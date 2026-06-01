import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { StatusBadge } from '@/components/StatusBadge';
import { site } from '@/lib/site';

const heroCode = `query CovenantLineage($id: String!) {
  covenantLineage(covenantId: $id) {
    covenantId
    parentUtxo
    childUtxos
    blockDaaScore
  }
}`;

export function Hero() {
  return (
    <section className="section grid gap-10 pb-20 pt-14 lg:grid-cols-[1.04fr_0.96fr] lg:items-center lg:pb-28 lg:pt-20">
      <div>
        <StatusBadge>Core feature-complete - hosted validation in progress</StatusBadge>
        <h1 className="text-balance mt-7 max-w-4xl text-5xl font-semibold leading-[1.02] tracking-tight text-[#f3fffc] sm:text-6xl lg:text-7xl">
          The Graph for Kaspa.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[#b7c9c5] sm:text-xl">
          AI-native subgraph indexing for Kaspa's UTXO, Covenant ID, KRC-20/KRC-721,
          and BlockDAG application layer.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link className="rounded-md bg-[#49EACB] px-5 py-3 text-sm font-semibold text-[#021110]" href={site.github}>
            View GitHub
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/docs">
            Read Docs
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/quickstart">
            Run Locally
          </Link>
          <Link className="rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/status">
            Request Hosted Access
          </Link>
        </div>
      </div>
      <div className="panel rounded-lg p-4">
        <div className="mb-4 grid grid-cols-3 gap-2 text-center text-xs text-[#8aa29d]">
          <span className="rounded border border-[#70C7BA]/18 py-2">GraphQL</span>
          <span className="rounded border border-[#70C7BA]/18 py-2">MCP</span>
          <span className="rounded border border-[#70C7BA]/18 py-2">KasStream</span>
        </div>
        <CodeBlock code={heroCode} title="typed query surface" />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {['KIP-20 lineage', 'POI chain', 'Postgres entities'].map((item) => (
            <div className="rounded-md border border-[#70C7BA]/18 bg-black/20 p-3 text-xs text-[#a9bbb7]" key={item}>
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
