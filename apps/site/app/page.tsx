import Link from 'next/link';
import { ArchitectureDiagram } from '@/components/ArchitectureDiagram';
import { CodeBlock } from '@/components/CodeBlock';
import { FeatureCard } from '@/components/FeatureCard';
import { Hero } from '@/components/Hero';

const workflow = `npx kasgraph init my-subgraph
cd my-subgraph
npx kasgraph codegen
npx kasgraph build
npx kasgraph deploy --database-url "$DATABASE_URL"
npx kasgraph status my-subgraph`;

const interfaces: Array<[string, string]> = [
  ['GraphQL', 'Typed subgraph queries over committed blocks, POI checkpoints, detected patterns, lineage, and deployed entity schemas.'],
  ['MCP', 'Agent-facing tools for listing subgraphs, fetching schemas, executing queries, searching patterns, and reading covenant lineage.'],
  ['KasStream', 'A streaming primitive for block-by-block event delivery and low-latency data products.'],
  ['WebSocket', 'Push subscriptions over the same gateway data plane for detected-pattern updates.'],
];

const primitives: Array<[string, string]> = [
  ['KIP-20 Covenant IDs', 'Stable lineage identifiers turn covenant state history into primary-key lookups instead of recursive UTXO walking.'],
  ['KRC-20 / KRC-721', 'Legacy inscription parsing and native covenant-era token models are treated as first-class indexing targets.'],
  ['BlockDAG reorgs', 'Committed and probabilistic block handling is designed around Kaspa virtual-chain changes and unwind semantics.'],
  ['Proof of Indexing', 'A blake2b-256 hash chain over indexed entity state enables third-party verification of indexer output.'],
  ['Multi-RPC failover', 'The RPC layer probes multiple sources and records fetch provenance for operational visibility.'],
  ['Postgres entities', 'Per-subgraph schemas, registry rows, lineage, checkpoints, and typed entity versions live in PostgreSQL.'],
];

const useCases = [
  'Wallets',
  'Explorers',
  'KRC-20/KRC-721 dashboards',
  'Covenant apps',
  'KasBonds',
  'OpenSilver',
  'AI agents',
  'Analytics platforms',
  'POI verification',
];

export default function Home() {
  return (
    <main>
      <Hero />

      <section className="section border-y hairline py-16">
        <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">why it exists</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
              Raw RPC is not enough for Kaspa applications.
            </h2>
          </div>
          <p className="text-lg leading-8 text-[#b7c9c5]">
            Wallets, explorers, dApps, analytics systems, covenant apps, native-asset dashboards,
            and AI agents need structured state. KasGraph turns Kaspa block and covenant activity
            into queryable entities, streams, agent tools, and verifiable indexing checkpoints.
          </p>
        </div>
      </section>

      <section className="section py-20">
        <div className="mb-9 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">one data plane</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
              Four interfaces ship together.
            </h2>
          </div>
          <Link className="text-sm font-medium text-[#49EACB]" href="/architecture">
            View architecture
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {interfaces.map(([title, description]) => (
            <FeatureCard description={description} key={title} title={title} />
          ))}
        </div>
      </section>

      <section className="section grid gap-8 py-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">architecture</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
            Kaspa-native indexing from RPC to agents.
          </h2>
          <p className="mt-5 text-lg leading-8 text-[#b7c9c5]">
            The node ingests Kaspa RPC and wRPC streams, applies detectors and WASM mappings,
            writes PostgreSQL state, computes POI checkpoints, and serves GraphQL, MCP,
            KasStream, and WebSocket consumers.
          </p>
        </div>
        <ArchitectureDiagram />
      </section>

      <section className="section grid gap-8 py-20 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
        <div>
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">developer workflow</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
            Subgraph-style authoring for Kaspa.
          </h2>
          <p className="mt-5 text-lg leading-8 text-[#b7c9c5]">
            Scaffold a subgraph, generate TypeScript types from GraphQL SDL, compile the
            AssemblyScript mapping to WASM, deploy it to a registry, then query the gateway.
          </p>
        </div>
        <CodeBlock code={workflow} title="quickstart" />
      </section>

      <section className="section py-16">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">kaspa primitives</p>
        <h2 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight text-[#f3fffc]">
          Built for UTXO, Covenant ID, native assets, and BlockDAG state.
        </h2>
        <div className="mt-9 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {primitives.map(([title, description]) => (
            <FeatureCard description={description} key={title} title={title} />
          ))}
        </div>
      </section>

      <section className="section grid gap-8 py-20 lg:grid-cols-[0.92fr_1.08fr] lg:items-center">
        <div>
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">ai-native</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
            Agents should not need to hand-write GraphQL to understand Kaspa state.
          </h2>
          <p className="mt-5 text-lg leading-8 text-[#b7c9c5]">
            MCP is a first-class surface, backed by the same registry and gateway path as the
            developer API.
          </p>
        </div>
        <div className="panel rounded-lg p-6">
          {['list_subgraphs', 'get_schema', 'execute_query', 'search_by_pattern', 'get_covenant_lineage'].map(
            (tool) => (
              <div className="flex items-center justify-between border-b border-[#70C7BA]/14 py-4 last:border-b-0" key={tool}>
                <span className="mono text-sm text-[#dffcf6]">{tool}</span>
                <span className="text-xs text-[#70C7BA]">live</span>
              </div>
            ),
          )}
        </div>
      </section>

      <section className="section py-16">
        <div className="panel rounded-lg p-7 sm:p-9">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">status</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
            Core infrastructure feature-complete. Public hosted validation is next.
          </h2>
          <p className="mt-5 max-w-4xl text-lg leading-8 text-[#b7c9c5]">
            The build {'->'} deploy {'->'} index {'->'} query pipeline is multi-tenant, hot-reloadable,
            and verified end-to-end against real Postgres. Remaining public-launch work includes
            live testnet soak, hosted topology, log streaming, benchmarks, and deployment confirmation.
          </p>
          <Link className="mt-7 inline-flex text-sm font-medium text-[#49EACB]" href="/status">
            Read the full status
          </Link>
        </div>
      </section>

      <section className="section py-16">
        <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">use cases</p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {useCases.map((item) => (
            <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm font-medium text-[#dffcf6]" key={item}>
              {item}
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
