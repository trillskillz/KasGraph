import { PageHero } from '@/components/PageHero';
import { site } from '@/lib/site';

const rows: Array<[string, string, string]> = [
  ['Structured logs', 'Implemented locally', 'API emits JSON lines; hosted protected log streaming is pending.'],
  ['/healthz and /health', 'Implemented', 'Backed by Postgres SELECT 1 in the API process.'],
  ['/status', 'Implemented', 'Reports observable gateway/Postgres state; RPC is unavailable unless wired by host.'],
  ['/metrics', 'Implemented', 'Prometheus-style gateway/Postgres metrics.'],
  ['Uptime checks', 'Documented', 'Needs provider setup on persistent host.'],
  ['Alerts', 'Documented', 'API, RPC, Postgres, DAA stall, resource, GraphQL, POI, streaming, and MCP alerts are defined.'],
  ['Protected logs', 'Pending', 'No public detailed logs are exposed.'],
];

export default function MonitoringPage() {
  return (
    <main>
      <PageHero
        eyebrow="monitoring"
        title="Monitoring is documented; hosted alerting is pending."
        description="KasGraph exposes health/status/metrics surfaces, but hosted log streaming and alerting require a persistent deployment and provider configuration."
      />
      <section className="section grid gap-4 md:grid-cols-2">
        {rows.map(([name, status, detail]) => (
          <article className="panel rounded-lg p-5" key={name}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-lg font-semibold text-[#eefefa]">{name}</h2>
              <span className="mono text-xs uppercase tracking-[0.16em] text-[#70C7BA]">{status}</span>
            </div>
            <p className="mt-3 text-sm leading-6 text-[#a9bbb7]">{detail}</p>
          </article>
        ))}
      </section>
      <section className="section py-16">
        <a className="rounded-md bg-[#49EACB] px-4 py-2 text-sm font-semibold text-[#021110]" href={`${site.github}/blob/main/docs/monitoring.md`}>
          Read Monitoring Docs
        </a>
      </section>
    </main>
  );
}
