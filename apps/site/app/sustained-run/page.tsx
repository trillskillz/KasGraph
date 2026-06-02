import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';
import { formatDuration, getLatestSoakSummary, soakValue } from '@/lib/soak';

export default function SustainedRunPage() {
  const soak = getLatestSoakSummary();
  const summary = soak.summary;
  const links: Array<[string, string, string]> = soak.hasSummary
    ? [
        ['Published soak report', `${site.github}/blob/main/docs/testnet-soak-report.md`, `${formatDuration(summary)} on ${soakValue(summary?.network)}; ${soakValue(summary?.verdict)}`],
        ['Public artifact directory', `${site.github}/tree/main/docs/artifacts/testnet-soak/${soakValue(summary?.runDate ?? soak.artifactDate)}`, `${soakValue(summary?.blocksIndexed)} blocks and ${soakValue(summary?.poiCheckpoints)} POI checkpoints.`],
        ['Site artifact mirror', `/docs/artifacts/testnet-soak/${soakValue(summary?.runDate ?? soak.artifactDate)}/summary.json`, 'Static site copy of the latest summary.json artifact.'],
        ['Restart notes', `${site.github}/blob/main/docs/artifacts/testnet-soak/${soakValue(summary?.runDate ?? soak.artifactDate)}/restart-recovery-notes.md`, soakValue(summary?.restartRecoveryVerdict, 'Restart recovery was not measured in this run.')],
      ]
    : [
        ['Run harness', `${site.github}/tree/main/scripts/soak`, 'Pending until a real testnet run is captured and sanitized.'],
        ['Sustained-run report', `${site.github}/blob/main/docs/sustained-run-report.md`, 'Pending until a real testnet run is captured and sanitized.'],
        ['Artifact directory', `${site.github}/tree/main/docs/artifacts/sustained-run`, 'Pending until a real testnet run is captured and sanitized.'],
        ['Restart template', `${site.github}/blob/main/docs/restart-recovery-notes-template.md`, 'Pending until a real testnet run is captured and sanitized.'],
      ];

  return (
    <main>
      <PageHero
        eyebrow="sustained run"
        title={soak.hasSummary ? 'Sustained testnet proof is published.' : 'Sustained-run proof is pending real artifacts.'}
        description={
          soak.hasSummary
            ? `The latest public artifact records ${formatDuration(summary)} on ${soakValue(summary?.network)} with checked-in logs, health snapshots, POI checkpoints, and run notes.`
            : 'The scripts and publication directories are ready for a persistent-host testnet run. No sustained-run logs or metrics are published yet.'
        }
      />
      <section className="section grid gap-4 md:grid-cols-2">
        {links.map(([label, href, description]) => (
          <a className="panel rounded-lg p-5 transition hover:border-[#49EACB]/45" href={href} key={label}>
            <h2 className="text-lg font-semibold text-[#eefefa]">{label}</h2>
            <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">{description}</p>
          </a>
        ))}
      </section>
    </main>
  );
}
