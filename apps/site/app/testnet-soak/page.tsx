import { CodeBlock } from '@/components/CodeBlock';
import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';
import { formatDuration, getLatestSoakSummary, soakValue } from '@/lib/soak';

const runCommand = `SOAK_DURATION_SECONDS=86400 \\
KASGRAPH_ENVIRONMENT=testnet \\
KASGRAPH_NETWORK=kaspa-testnet-10 \\
KASGRAPH_API_URL=http://127.0.0.1:4000 \\
KASGRAPH_GRAPHQL_URL=http://127.0.0.1:4000/graphql \\
bash scripts/soak/run-testnet-soak.sh`;

const artifacts = [
  ['Live dashboard', '/testnet-soak/live'],
  ['Soak plan', `${site.github}/blob/main/docs/testnet-soak-plan.md`],
  ['Soak report', `${site.github}/blob/main/docs/testnet-soak-report.md`],
  ['Artifact directory policy', `${site.github}/blob/main/docs/artifacts/testnet-soak/README.md`],
  ['Soak scripts', `${site.github}/tree/main/scripts/soak`],
];

export default function TestnetSoakPage() {
  const soak = getLatestSoakSummary();
  const summary = soak.summary;
  const statusRows: Array<[string, string]> = soak.hasSummary
    ? [
        ['Status', soakValue(summary?.status)],
        ['Run date', soakValue(summary?.runDate ?? soak.artifactDate)],
        ['Duration', formatDuration(summary)],
        ['Network', soakValue(summary?.network)],
        ['DAA start/end', `${soakValue(summary?.daaStart)} / ${soakValue(summary?.daaEnd)}`],
        ['Blocks indexed', soakValue(summary?.blocksIndexed)],
        ['POI checkpoints', soakValue(summary?.poiCheckpoints)],
        ['Restart recovery', soakValue(summary?.restartRecoveryVerdict, 'Not measured')],
        ['Known issues', soakValue(summary?.knownIssues, 'None published')],
        ['Verdict', soakValue(summary?.verdict)],
      ]
    : [
        ['Status', 'Pending run'],
        ['Network', 'Target: kaspa-testnet-10'],
        ['Minimum duration', '24 hours'],
        ['Preferred duration', '72+ hours'],
        ['DAA start/end', 'N/A'],
        ['Blocks indexed', 'N/A'],
        ['POI checkpoints', 'N/A'],
        ['Restart recovery', 'Not measured'],
        ['Public logs', 'Not published'],
        ['Verdict', 'Incomplete; more data required'],
      ];

  return (
    <main>
      <PageHero
        eyebrow="testnet soak"
        title={soak.hasSummary ? 'Sustained testnet validation artifact published.' : 'Sustained testnet validation is prepared, not completed.'}
        description={
          soak.hasSummary
            ? 'This page is rendering the latest checked-in summary.json from the public testnet soak artifact directory. Values are only as strong as the published artifact.'
            : 'KasGraph has repeatable soak scripts and report templates, but no 24-hour testnet indexing artifact has been published yet. This page will switch to measured results only after a real run completes.'
        }
      />
      <section className="section grid gap-5 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="panel rounded-lg p-7">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">current soak state</p>
          <h2 className="mt-4 text-2xl font-semibold text-[#f3fffc]">
            {soak.hasSummary ? soakValue(summary?.verdict, 'Summary published') : 'Incomplete; more data required.'}
          </h2>
          <p className="mt-4 leading-7 text-[#b7c9c5]">
            {soak.hasSummary
              ? 'The rows below come from the latest public summary artifact found during the static site build.'
              : 'No fake logs, metrics, endpoints, or restart claims are published. The next validation step is a real testnet run with sanitized public artifacts.'}
          </p>
          <div className="mt-6 grid gap-3">
            {statusRows.map(([label, value]) => (
              <div className="flex flex-wrap justify-between gap-3 rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4" key={label}>
                <span className="text-sm text-[#a9bbb7]">{label}</span>
                <span className="mono text-sm text-[#dffcf6]">{value}</span>
              </div>
            ))}
          </div>
        </div>
        <CodeBlock code={runCommand} title="repeatable soak command" />
      </section>
      <section className="section py-16">
        <h2 className="text-3xl font-semibold tracking-tight text-[#f3fffc]">Artifacts</h2>
        {soak.hasSummary && summary?.publicLogs ? (
          <div className="mt-6 grid gap-3 md:grid-cols-2">
            {Object.entries(summary.publicLogs).map(([label, href]) => (
              <a className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm font-semibold text-[#dffcf6] transition hover:border-[#49EACB]/45" href={href} key={label}>
                {label}
              </a>
            ))}
          </div>
        ) : null}
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {artifacts.map(([label, href]) => (
            <a className="panel rounded-lg p-5 transition hover:border-[#49EACB]/45" href={href} key={label}>
              <h3 className="text-lg font-semibold text-[#eefefa]">{label}</h3>
              <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">
                Opens the repository artifact or script location. Values remain placeholders until a real run is captured.
              </p>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
