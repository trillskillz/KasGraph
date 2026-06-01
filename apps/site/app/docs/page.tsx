import { CodeBlock } from '@/components/CodeBlock';
import { FeatureCard } from '@/components/FeatureCard';
import { PageHero } from '@/components/PageHero';

const repoMap: Array<[string, string]> = [
  ['crates/kasgraph-node', 'Indexer binary: ingest, detect, map, persist, POI, fan-out, registry reload.'],
  ['crates/kasgraph-rpc', 'Multi-RPC client with failover, health probes, and continuous wRPC recovery.'],
  ['crates/kasgraph-store', 'Postgres adapter for migrations, schemas, registry, lineage, and reorg-safe unwind.'],
  ['crates/kasgraph-detectors', 'OpenSilver, KCC20, KRC-20/KRC-721 pattern detectors and ledgers.'],
  ['crates/kasgraph-mapping', 'Wasmtime runtime for deterministic AssemblyScript mapping handlers.'],
  ['crates/kasgraph-poi', 'Proof of Indexing hash chain and verifier.'],
  ['crates/kasgraph-stream', 'KasStream event delivery primitive.'],
  ['sdk / cli / api / mcp', 'TypeScript SDK, CLI, GraphQL gateway, and MCP package surfaces.'],
];

const install = `git clone https://github.com/trillskillz/KasGraph
cd KasGraph
npm install
npm run verify`;

const cli = `npx kasgraph init my-subgraph
npx kasgraph codegen
npx kasgraph build
npx kasgraph deploy --database-url "$DATABASE_URL"
npx kasgraph deploy --node https://your-node
npx kasgraph status my-subgraph
npx kasgraph remove my-subgraph
npx kasgraph mcp-config`;

export default function DocsPage() {
  return (
    <main>
      <PageHero
        eyebrow="docs overview"
        title="KasGraph documentation starts from the monorepo."
        description="This site summarizes the live package and crate surfaces. The canonical implementation details remain in README.md, STATUS.md, PLAN.md, and docs/references inside GitHub."
      />
      <section className="section grid gap-6 lg:grid-cols-2">
        <CodeBlock code={install} title="clone and verify" />
        <CodeBlock code={cli} title="cli commands" />
      </section>
      <section className="section py-16">
        <h2 className="text-3xl font-semibold tracking-tight text-[#f3fffc]">Repo map</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {repoMap.map(([title, description]) => (
            <FeatureCard description={description} key={title} title={title} />
          ))}
        </div>
      </section>
      <section className="section py-8">
        <div className="panel rounded-lg p-7">
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Reference topics</h2>
          <p className="mt-4 leading-7 text-[#b7c9c5]">
            The repo includes reference docs for KIP-20 Covenant ID queries, BlockDAG reorg
            semantics, The Graph compatibility, native KRC-20/KRC-721 shape, and the Kaspa RPC layer.
          </p>
        </div>
      </section>
    </main>
  );
}
