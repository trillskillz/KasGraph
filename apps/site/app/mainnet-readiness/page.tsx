import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';

const gates = [
  'Hosted API stable',
  'Database backups configured',
  'Monitoring and protected logs configured',
  'Rate limiting and admin auth configured',
  'Sustained testnet run completed',
  'Restart/reorg/POI continuity validated',
  'Playground live against verified data',
  'Security review complete',
  'Runbook tested',
];

export default function MainnetReadinessPage() {
  return (
    <main>
      <PageHero
        eyebrow="mainnet readiness"
        title="Mainnet readiness is not claimed."
        description="KasGraph has a formal checklist, but the gates are not complete. This page intentionally keeps mainnet status separate from local implementation progress."
      />
      <section className="section grid gap-3 md:grid-cols-2">
        {gates.map((gate) => (
          <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm leading-6 text-[#dffcf6]" key={gate}>
            {gate}: pending validation
          </div>
        ))}
      </section>
      <section className="section py-16">
        <a className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href={`${site.github}/blob/main/docs/mainnet-readiness.md`}>
          Read Checklist
        </a>
      </section>
    </main>
  );
}
