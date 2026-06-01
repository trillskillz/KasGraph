const rows: Array<[string, string, string, string, string]> = [
  ['Indexing throughput', 'Pending', 'TBD blocks/sec', 'Pending measurement', 'Awaiting sustained testnet soak.'],
  ['GraphQL query latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires hosted endpoint and representative subgraphs.'],
  ['Reorg handling latency', 'Pending', 'TBD seconds', 'Pending measurement', 'Needs controlled virtual-chain/reorg simulation.'],
  ['PostgreSQL storage growth', 'Pending', 'TBD GB / million txs', 'Pending measurement', 'Depends on entity volume and indexing profile.'],
  ['WebSocket/KasStream event latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires live streaming deployment.'],
  ['MCP tool response latency', 'Pending', 'TBD ms p95', 'Pending measurement', 'Requires hosted MCP/gateway path.'],
  ['Proof-of-Indexing checkpoint cost', 'Pending', 'TBD ms/checkpoint', 'Pending measurement', 'Depends on entity update volume.'],
  ['Testnet soak duration', 'Not run', '24h minimum / 72h preferred', 'Pending validation', 'Harness added; no sustained testnet artifact has been published.'],
  ['Mainnet readiness', 'Not validated', 'Defined checklist', 'Not production-ready', 'Requires testnet soak, monitoring, benchmarks, and runbooks.'],
];

const cards: Array<[string, string]> = [
  ['Indexing throughput', 'Pending measurement'],
  ['Query latency', 'Pending measurement'],
  ['Reorg handling latency', 'Pending measurement'],
  ['PostgreSQL storage growth', 'Pending measurement'],
  ['WebSocket/KasStream event latency', 'Pending measurement'],
  ['MCP tool response latency', 'Pending measurement'],
  ['POI checkpoint cost', 'Pending measurement'],
  ['Testnet soak duration', 'Not run'],
  ['Mainnet readiness', 'Not production-ready'],
];

export function BenchmarksTable() {
  return (
    <section className="section py-16">
      <div className="mb-8 max-w-4xl">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">benchmarks</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">Benchmarks.</h2>
        <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
          This is the public placeholder for performance data. The soak harness exists, but results
          remain pending until sustained testnet/mainnet validation produces repeatable measurements.
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
    </section>
  );
}
