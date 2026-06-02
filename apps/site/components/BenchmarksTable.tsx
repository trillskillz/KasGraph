import { formatDuration, getLatestSoakSummary, soakValue } from '@/lib/soak';

export function BenchmarksTable() {
  const soak = getLatestSoakSummary();
  const summary = soak.summary;
  const soakDuration = soak.hasSummary ? formatDuration(summary) : '24h minimum / 72h preferred';
  const soakStatus = soak.hasSummary ? soakValue(summary?.status, 'Published') : 'Pending validation';
  const soakNotes = soak.hasSummary
    ? `Published ${soakValue(summary?.runDate ?? soak.artifactDate)} artifact on ${soakValue(summary?.network)} with ${soakValue(summary?.blocksIndexed)} blocks and ${soakValue(summary?.poiCheckpoints)} POI checkpoints.`
    : 'Harness added; no sustained testnet artifact has been published.';
  const rows: Array<[string, string, string, string, string]> = [
    ['Indexing throughput', 'Pending', 'TBD blocks/sec', 'Pending measurement', 'Requires repeatable benchmark run beyond the completed soak.'],
    ['GraphQL query latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires hosted endpoint and representative subgraphs.'],
    ['Reorg handling latency', 'Pending', 'TBD seconds', 'Pending measurement', 'Needs controlled virtual-chain/reorg simulation.'],
    ['PostgreSQL storage growth', 'Pending', 'TBD GB / million txs', 'Pending measurement', 'Depends on entity volume and indexing profile.'],
    ['WebSocket/KasStream event latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires live streaming deployment.'],
    ['MCP tool response latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires hosted MCP/gateway path.'],
    ['Proof-of-Indexing checkpoint cost', 'Pending', 'TBD ms/checkpoint', 'Pending measurement', 'Depends on entity update volume.'],
    ['Testnet soak duration', soakDuration, '24h minimum / 72h preferred', soakStatus, soakNotes],
    ['Mainnet readiness', 'Not validated', 'Defined checklist', 'Not production-ready', 'Requires monitoring, benchmarks, runbooks, and mainnet validation.'],
  ];
  const cards: Array<[string, string]> = [
    ['Indexing throughput', 'Pending measurement'],
    ['Query latency', 'Pending measurement'],
    ['Reorg handling latency', 'Pending measurement'],
    ['PostgreSQL storage growth', 'Pending measurement'],
    ['WebSocket/KasStream event latency', 'Pending measurement'],
    ['MCP tool response latency', 'Pending measurement'],
    ['POI checkpoint cost', 'Pending measurement'],
    ['Testnet soak duration', soak.hasSummary ? soakDuration : 'Not run'],
    ['Mainnet readiness', 'Not production-ready'],
  ];

  return (
    <section className="section py-16">
      <div className="mb-8 max-w-4xl">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">benchmarks</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">Benchmarks.</h2>
        <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
          This table separates the published testnet soak artifact from performance benchmarks that
          still need repeatable hosted measurements.
        </p>
      </div>
      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map(([title, status]) => (
          <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4" key={title}>
            <h3 className="font-semibold text-[#eefefa]">{title}</h3>
            <p className="mono mt-3 text-xs uppercase tracking-[0.16em] text-[#70C7BA]">{status}</p>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-lg border border-[#70C7BA]/20">
        <div className="overflow-x-auto">
          <table className="min-w-[920px] w-full border-collapse text-left text-sm">
            <thead className="bg-[#49EACB]/10 text-[#dffcf6]">
              <tr>
                {['Metric', 'Current Result', 'Target', 'Status', 'Notes'].map((heading) => (
                  <th className="px-4 py-3 font-semibold" key={heading}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#70C7BA]/14 bg-black/20 text-[#b7c9c5]">
              {rows.map(([metric, current, target, status, notes]) => (
                <tr key={metric}>
                  <td className="px-4 py-4 font-medium text-[#f3fffc]">{metric}</td>
                  <td className="px-4 py-4">{current}</td>
                  <td className="px-4 py-4">{target}</td>
                  <td className="px-4 py-4">{status}</td>
                  <td className="px-4 py-4">{notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <a className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href="https://github.com/trillskillz/KasGraph/blob/main/docs/benchmarks.md">
          Benchmark Methodology
        </a>
        <a className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href="https://github.com/trillskillz/KasGraph/tree/main/scripts/bench">
          Benchmark Scripts
        </a>
      </div>
    </section>
  );
}
