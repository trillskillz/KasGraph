import { CodeBlock } from '@/components/CodeBlock';
import { PageHero } from '@/components/PageHero';
import { hostedEnvVars } from '@/lib/site';

const verify = `git clone https://github.com/trillskillz/KasGraph
cd KasGraph
npm install
npm run verify`;

const subgraph = `npx kasgraph init my-subgraph
cd my-subgraph
# edit schema.graphql + src/mapping.ts
npx kasgraph codegen
npx kasgraph build
npx kasgraph deploy --database-url "$DATABASE_URL"
npx kasgraph status my-subgraph`;

const node = `DATABASE_URL="$DATABASE_URL" \\
KASGRAPH_INGEST_MODE=continuous \\
KASGRAPH_NOTIFICATION_WS_URL=wss://your-kaspa-node/wrpc/json \\
KASGRAPH_RELOAD_INTERVAL_SECS=30 \\
  cargo run -p kasgraph-node`;

export default function QuickstartPage() {
  return (
    <main>
      <PageHero
        eyebrow="quickstart"
        title="Run the KasGraph toolchain locally."
        description="These commands come from the repo README. A hosted node is not required for local verification or direct database deployment."
      />
      <section className="section grid gap-6">
        <CodeBlock code={verify} title="install and verify" />
        <CodeBlock code={subgraph} title="build and deploy a subgraph" />
        <CodeBlock code={node} title="run the indexer node" />
      </section>
      <section className="section py-16">
        <div className="panel rounded-lg p-7">
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Hosted node environment</h2>
          <p className="mt-4 leading-7 text-[#b7c9c5]">
            Future hosted API/indexer deployments should run on Railway, Fly.io, Render, or a VPS
            with managed Postgres. These values belong in the platform secret store and must not be committed.
          </p>
          <div className="mt-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {hostedEnvVars.map((name) => (
              <span className="mono rounded border border-[#70C7BA]/18 bg-black/20 px-3 py-2 text-xs text-[#dffcf6]" key={name}>
                {name}
              </span>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
