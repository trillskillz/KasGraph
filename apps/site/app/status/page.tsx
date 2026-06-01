import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';
import { formatDuration, getLatestSoakSummary, soakValue } from '@/lib/soak';

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

const operatorDocs: Array<[string, string]> = [
  ['Hosted endpoint docs', `${site.github}/blob/main/docs/hosted-api.md`],
  ['Benchmark methodology', '/benchmarks'],
  ['Testnet soak page', '/testnet-soak'],
  ['Testnet soak plan', `${site.github}/blob/main/docs/testnet-soak-plan.md`],
  ['Testnet soak report template', `${site.github}/blob/main/docs/testnet-soak-report.md`],
  ['Mainnet readiness checklist', `${site.github}/blob/main/docs/mainnet-readiness.md`],
  ['Operator runbook', `${site.github}/blob/main/docs/runbook.md`],
  ['Monitoring docs', `${site.github}/blob/main/docs/monitoring.md`],
];

function statusClass(status: string): string {
  if (status === 'Implemented') return 'text-[#49EACB]';
  if (status === 'Coming soon') return 'text-[#dffcf6]';
  if (status === 'Not production-ready') return 'text-[#ffb4a8]';
  return 'text-[#70C7BA]';
}

export default function StatusPage() {
  const soak = getLatestSoakSummary();
  const summary = soak.summary;
  const testnetSoak: Array<[string, string]> = soak.hasSummary
    ? [
        ['Status', soakValue(summary?.status)],
        ['Run date', soakValue(summary?.runDate ?? soak.artifactDate)],
        ['Duration', formatDuration(summary)],
        ['Network', soakValue(summary?.network)],
        ['DAA start / end', `${soakValue(summary?.daaStart)} / ${soakValue(summary?.daaEnd)}`],
        ['Blocks indexed', soakValue(summary?.blocksIndexed)],
        ['POI checkpoints', soakValue(summary?.poiCheckpoints)],
        ['Restart recovery', soakValue(summary?.restartRecoveryVerdict, 'Not measured')],
        ['Known issues', soakValue(summary?.knownIssues, 'None published')],
      ]
    : [
        ['Status', 'Pending run'],
        ['Run date', 'N/A'],
        ['Duration', 'N/A'],
        ['Network', 'Target: kaspa-testnet-10'],
        ['DAA start / end', 'N/A'],
        ['Blocks indexed', 'N/A'],
        ['POI checkpoints', 'N/A'],
        ['Restart recovery', 'Not measured'],
        ['Known issues', 'No 24h testnet artifact, no public logs, no restart notes yet.'],
      ];

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
      <section className="section pb-16">
        <div className="panel rounded-lg p-7">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">testnet soak</p>
          <h2 className="mt-4 text-2xl font-semibold text-[#f3fffc]">
            {soak.hasSummary ? 'Latest public testnet soak summary.' : 'Sustained testnet validation is still pending.'}
          </h2>
          <p className="mt-4 leading-7 text-[#b7c9c5]">
            {soak.hasSummary
              ? 'This section renders the latest checked-in summary.json from docs/artifacts/testnet-soak. Mainnet production readiness remains a separate checklist.'
              : 'The soak harness and report structure are ready, but no 24-hour testnet indexing run has been published. Mainnet production readiness remains explicitly unclaimed.'}
          </p>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {testnetSoak.map(([label, value]) => (
              <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4" key={label}>
                <p className="mono text-[11px] uppercase tracking-[0.16em] text-[#70C7BA]">{label}</p>
                <p className="mt-2 text-sm leading-6 text-[#dffcf6]">{value}</p>
              </div>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            <a className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href="/testnet-soak">
              View Soak Status
            </a>
            <a className="rounded-md border border-[#49EACB]/35 px-4 py-2 text-sm font-semibold text-[#dffcf6]" href={`${site.github}/blob/main/docs/testnet-soak-report.md`}>
              Full Report
            </a>
          </div>
        </div>
      </section>
      <section className="section pb-16">
        <div className="panel rounded-lg p-7">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">operator docs</p>
          <h2 className="mt-4 text-2xl font-semibold text-[#f3fffc]">
            Validation artifacts and runbooks.
          </h2>
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {operatorDocs.map(([label, href]) => (
              <a
                className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm font-semibold text-[#dffcf6] transition hover:border-[#49EACB]/45"
                href={href}
                key={label}
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
