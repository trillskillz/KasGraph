import { PageHero } from '@/components/PageHero';

const groups: Array<[string, Array<[string, string, string]>]> = [
  [
    'What works locally',
    [
      ['Core indexer', 'Implemented', 'Rust node ingest/detect/map/persist path exists in the repo.'],
      ['Postgres entity store', 'Implemented', 'Registry, schemas, lineage, entity state, and checkpoints use Postgres.'],
      ['GraphQL API', 'Implemented', 'Gateway package serves base and per-subgraph query surfaces.'],
      ['CLI', 'Implemented', 'init, codegen, build, deploy, status, remove, and mcp-config are implemented.'],
      ['SDK', 'Implemented', 'TypeScript package surface exists for developer integration.'],
      ['MCP tools', 'Implemented', 'list_subgraphs, get_schema, execute_query, search_by_pattern, get_covenant_lineage.'],
      ['Proof of Indexing', 'Implemented', 'Core POI checkpoint/verifier path exists, with CLI ergonomics still pending.'],
    ],
  ],
  [
    'Implemented but needs hosted validation',
    [
      ['WebSocket subscriptions', 'Pending validation', 'Needs public hosted gateway validation under live traffic.'],
      ['KasStream events', 'Pending validation', 'Needs live streaming deployment and latency measurement.'],
      ['KRC-20 support', 'Pending validation', 'Detectors/ledgers exist; public indexed datasets are not published yet.'],
      ['KRC-721 support', 'Pending validation', 'Detectors/ledgers exist; public indexed datasets are not published yet.'],
      ['Covenant ID indexing', 'Pending validation', 'Core model exists; needs public testnet/mainnet validation.'],
      ['Reorg handling', 'Pending validation', 'Implemented semantics need controlled simulation and soak results.'],
    ],
  ],
  [
    'Coming soon',
    [
      ['Hosted endpoint', 'Coming soon', 'No public hosted API is advertised until topology and auth are validated.'],
      ['Public playground', 'Coming soon', 'Will link only after a real endpoint exists.'],
      ['Monitoring/log streaming', 'Coming soon', 'CLI logs is intentionally stubbed until hosted log streaming exists.'],
      ['Production deployment docs', 'Coming soon', 'Runbooks and cloud topology docs need final validation.'],
    ],
  ],
  [
    'Not production-ready yet',
    [
      ['Testnet soak', 'Not production-ready', 'Sustained live testnet run is still required.'],
      ['Mainnet validation', 'Not production-ready', 'No mainnet readiness claim is made.'],
      ['Benchmarks', 'Pending measurement', 'Throughput, latency, storage, POI, streaming, and MCP metrics are pending.'],
    ],
  ],
];

const readiness = [
  'Sustained testnet soak with public logs and restart/recovery notes',
  'Published benchmark methodology and repeatable results',
  'Hosted API, playground, and MCP endpoint with monitoring',
  'Documented reorg simulation and recovery behavior',
  'Mainnet runbook, rollback plan, and deployment topology',
  'Security review for deploy auth and hosted write paths',
];

function statusClass(status: string): string {
  if (status === 'Implemented') return 'text-[#49EACB]';
  if (status === 'Coming soon') return 'text-[#dffcf6]';
  if (status === 'Not production-ready') return 'text-[#ffb4a8]';
  return 'text-[#70C7BA]';
}

export default function StatusPage() {
  return (
    <main>
      <PageHero
        eyebrow="status"
        title="Maturity is explicit: local core works, hosted production claims are pending."
        description="KasGraph should not be described as production-ready yet. This page separates implemented surfaces from hosted validation, benchmark, and mainnet-readiness work."
      />
      <section className="section grid gap-8">
        {groups.map(([title, items]) => (
          <div key={title}>
            <h2 className="text-2xl font-semibold text-[#f3fffc]">{title}</h2>
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {items.map(([name, status, notes]) => (
                <article className="panel rounded-lg p-5" key={name}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h3 className="text-lg font-semibold text-[#eefefa]">{name}</h3>
                    <span className={`mono text-xs uppercase tracking-[0.16em] ${statusClass(status)}`}>{status}</span>
                  </div>
                  <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">{notes}</p>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>
      <section className="section py-16">
        <div className="panel rounded-lg p-7">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">before mainnet claims</p>
          <h2 className="mt-4 text-2xl font-semibold text-[#f3fffc]">
            What must happen before public production readiness.
          </h2>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {readiness.map((item) => (
              <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm leading-6 text-[#dffcf6]" key={item}>
                {item}
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
