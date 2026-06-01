import Link from 'next/link';
import { CodeBlock } from '@/components/CodeBlock';
import { StatusBadge } from '@/components/StatusBadge';
import { site } from '@/lib/site';

const heroCode = `query CovenantActivity($covenantId: String!) {
  covenant(id: $covenantId) {
    id
    transactions {
      hash
      daaScore
      acceptedAt
      inputs
      outputs
    }
  }
}`;

const credibility = [
  'GraphQL',
  'MCP',
  'WebSockets',
  'KasStream',
  'Postgres',
  'Proof of Indexing',
  'BlockDAG-aware reorg handling',
];

export function Hero() {
  return (
    <section className="section grid gap-10 pb-16 pt-14 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:pb-24 lg:pt-20">
      <div>
        <StatusBadge>Kaspa-native indexing and query infrastructure</StatusBadge>
        <h1 className="text-balance mt-7 max-w-4xl text-5xl font-semibold leading-[1.02] tracking-tight text-[#f3fffc] sm:text-6xl lg:text-7xl">
          Structured indexing for Kaspa applications.
        </h1>
        <p className="mt-6 max-w-2xl text-lg leading-8 text-[#b7c9c5] sm:text-xl">
          KasGraph turns Kaspa blocks, UTXOs, Covenant IDs, KRC assets, and BlockDAG
          activity into queryable data for wallets, explorers, dashboards, dApps, and AI agents.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link className="rounded-md bg-[#49EACB] px-5 py-3 text-sm font-semibold text-[#021110]" href={site.github}>
            View GitHub
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/docs">
            Read Docs
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/playground">
            Playground Coming Soon
          </Link>
          <Link className="rounded-md border border-white/15 px-5 py-3 text-sm font-semibold text-[#dffcf6]" href="/status">
            Check Status
          </Link>
        </div>
        <div className="mt-8 flex max-w-3xl flex-wrap gap-x-3 gap-y-2 text-sm text-[#8fb4ad]">
          {credibility.map((item, index) => (
            <span className="inline-flex items-center gap-3" key={item}>
              <span>{item}</span>
              {index < credibility.length - 1 ? <span className="text-[#49EACB]/45">·</span> : null}
            </span>
          ))}
        </div>
      </div>
      <div className="panel rounded-lg p-4">
        <div className="mb-4">
          <p className="mono text-xs uppercase tracking-[0.22em] text-[#49EACB]">query demo</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-[#f3fffc]">
            Query Kaspa state like application data.
          </h2>
          <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">
            Ask for covenant activity, token balances, indexed entities, or BlockDAG-aware history
            without parsing raw blocks and UTXO responses in every app.
          </p>
        </div>
        <CodeBlock code={heroCode} title="graphql" />
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {['Covenant IDs', 'KRC assets', 'DAA-aware history'].map((item) => (
            <div className="rounded-md border border-[#70C7BA]/18 bg-black/20 p-3 text-xs text-[#a9bbb7]" key={item}>
              {item}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
