import { FeatureCard } from '@/components/FeatureCard';
import { PageHero } from '@/components/PageHero';

const done: Array<[string, string]> = [
  ['Core pipeline', 'Build -> deploy -> index -> query is multi-tenant, hot-reloadable, and verified end-to-end against real Postgres.'],
  ['GraphQL gateway', 'Committed blocks, POI checkpoints, detected patterns, covenant lineage, entities, and typed per-subgraph schemas.'],
  ['MCP surface', 'Five registry-aware tools are live: list_subgraphs, get_schema, execute_query, search_by_pattern, get_covenant_lineage.'],
  ['CLI workflow', 'init, codegen, build, deploy, status, remove, and mcp-config are implemented. logs remains pending hosted log streaming.'],
];

const remaining: Array<[string, string]> = [
  ['Live testnet soak', 'A public hosted indexing run still needs operational validation before production claims.'],
  ['Hosted topology', 'Cloud provider, managed Postgres, identity model, and service process layout need final confirmation.'],
  ['Log streaming', 'The CLI logs command is intentionally stubbed until hosted node log streaming exists.'],
  ['Benchmarks', 'Latency and concurrency targets are design targets until published load testing is complete.'],
];

export default function StatusPage() {
  return (
    <main>
      <PageHero
        eyebrow="status"
        title="Core infrastructure feature-complete. Pre-public operational validation remains."
        description="KasGraph should not be described as production-ready yet. The repository status is strong on core indexing functionality and intentionally honest about hosted launch work."
      />
      <section className="section grid gap-10 lg:grid-cols-2">
        <div>
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Implemented</h2>
          <div className="mt-6 grid gap-4">
            {done.map(([title, description]) => (
              <FeatureCard description={description} key={title} title={title} />
            ))}
          </div>
        </div>
        <div>
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Public launch work</h2>
          <div className="mt-6 grid gap-4">
            {remaining.map(([title, description]) => (
              <FeatureCard description={description} key={title} title={title} />
            ))}
          </div>
        </div>
      </section>
      <section className="section py-16">
        <div className="panel rounded-lg p-7">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">current public-hosted status</p>
          <p className="mt-4 text-lg leading-8 text-[#b7c9c5]">
            Hosted node and playground are coming soon. No public API endpoint is advertised on this site until the
            service topology, bearer-token deployment auth, live testnet soak, and operational metrics are validated.
          </p>
        </div>
      </section>
    </main>
  );
}
