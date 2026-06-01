import Link from 'next/link';
import { site } from '@/lib/site';

const areas = [
  'Indexer core',
  'GraphQL schema',
  'KRC asset mappings',
  'Covenant detectors',
  'MCP tools',
  'Docs/tutorials',
  'Benchmarks',
  'Testnet soak testing',
  'Example dashboards',
];

export function ContributeSection() {
  return (
    <section className="section py-16">
      <div className="panel rounded-lg p-7 sm:p-9">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">contribute</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">Contribute to KasGraph.</h2>
        <p className="mt-4 max-w-4xl text-lg leading-8 text-[#b7c9c5]">
          KasGraph is open-source infrastructure. Useful contributions include indexing correctness,
          example subgraphs, benchmark harnesses, docs, and operational validation.
        </p>
        <div className="mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {areas.map((area) => (
            <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm font-medium text-[#dffcf6]" key={area}>
              {area}
            </div>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href={site.github}>
            View GitHub
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href={`${site.github}/issues`}>
            Issues
          </Link>
          <Link className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href={`${site.github}/discussions`}>
            Discussions
          </Link>
          <Link className="rounded-md border border-white/15 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="/docs">
            Docs
          </Link>
          <Link className="rounded-md border border-white/15 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="/status">
            Status
          </Link>
        </div>
      </div>
    </section>
  );
}
