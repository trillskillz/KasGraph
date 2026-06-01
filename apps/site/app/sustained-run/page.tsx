import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';

export default function SustainedRunPage() {
  return (
    <main>
      <PageHero
        eyebrow="sustained run"
        title="Sustained-run proof is pending real artifacts."
        description="The scripts and publication directories are ready for a persistent-host testnet run. No sustained-run logs or metrics are published yet."
      />
      <section className="section grid gap-4 md:grid-cols-2">
        {[
          ['Run harness', `${site.github}/tree/main/scripts/soak`],
          ['Sustained-run report', `${site.github}/blob/main/docs/sustained-run-report.md`],
          ['Artifact directory', `${site.github}/tree/main/docs/artifacts/sustained-run`],
          ['Restart template', `${site.github}/blob/main/docs/restart-recovery-notes-template.md`],
        ].map(([label, href]) => (
          <a className="panel rounded-lg p-5 transition hover:border-[#49EACB]/45" href={href} key={label}>
            <h2 className="text-lg font-semibold text-[#eefefa]">{label}</h2>
            <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">Pending until a real testnet run is captured and sanitized.</p>
          </a>
        ))}
      </section>
    </main>
  );
}
