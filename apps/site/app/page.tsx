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
  ['GraphQL', 'Typed queries over indexed entities, covenant lineage, asset state, checkpoints, and subgraph schemas.'],
  ['MCP', 'Agent tools for listing subgraphs, reading schemas, executing queries, searching patterns, and inspecting lineage.'],
  ['WebSockets', 'Push updates for explorers, dashboards, wallets, and operational views that need fresh indexed state.'],
  ['KasStream', 'A low-latency stream of detected Kaspa activity for event-driven products and downstream pipelines.'],
];

const primitives: Array<[string, string]> = [
  ['UTXO-first indexing', 'Model application state from inputs, outputs, spends, and lineage instead of forcing an account-based event-log shape.'],
  ['KIP-20 Covenant IDs', 'Use stable consensus-tracked identifiers to query covenant history without recursive UTXO walking in every app.'],
  ['KRC-20 / KRC-721 assets', 'Index legacy inscription activity and native covenant-era assets as first-class query targets.'],
  ['BlockDAG reorg handling', 'Track committed and probabilistic block state with unwind semantics designed for Kaspa virtual-chain changes.'],
  ['Postgres-backed entities', 'Store deployed subgraphs, schemas, checkpoints, lineage, and versioned entities in a durable relational model.'],
  ['Proof of Indexing', 'Maintain a blake2b-256 hash chain over indexed entity state so output can be independently verified.'],
];

const useCases = [
  ['Wallets', 'Show balances, activity, covenant positions, and asset history without bespoke block parsers.'],
  ['Explorers', 'Serve structured transaction, asset, contract, and lineage views from indexed state.'],
  ['KRC tools', 'Track KRC-20/KRC-721 transfers, ownership, supply, and dashboards across legacy and native models.'],
  ['Covenant apps', 'Query state transitions by Covenant ID and expose app-specific entities through GraphQL.'],
  ['Analytics platforms', 'Build time-series and ecosystem views on top of normalized Kaspa application data.'],
  ['AI agents', 'Use MCP tools to inspect schemas, search patterns, and answer questions without raw RPC handling.'],
];

export default function Home() {
  return (
    <main>
      <Hero />

      <section className="section border-y hairline py-16">
        <div className="grid gap-10 lg:grid-cols-[0.82fr_1.18fr] lg:items-start">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">what it solves</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
              Kaspa apps need indexed state, not another raw RPC wrapper.
            </h2>
          </div>
          <p className="text-lg leading-8 text-[#b7c9c5]">
            KasGraph gives developers a shared indexing layer for blocks, UTXOs, Covenant IDs,
            KRC assets, reorg-aware history, and application-specific entities. Wallets, explorers,
            dashboards, covenant apps, analytics systems, and AI agents can query the same data plane
            instead of each rebuilding parsers, storage, reconciliation, and RPC failover.
          </p>
        </div>
      </section>

      <section className="section py-16">
        <div className="mb-8 max-w-3xl">
          <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">who it is for</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
            Infrastructure for teams building on Kaspa state.
          </h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {useCases.map(([title, description]) => (
            <FeatureCard description={description} key={title} title={title} />
          ))}
        </div>
      </section>

      <section className="section py-20">
        <div className="mb-9 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">one data plane</p>
            <h2 className="mt-4 text-3xl font-semibold tracking-tight text-[#f3fffc]">
              Query, stream, and automate through one indexed data plane.
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
            Purpose-built around Kaspa primitives.
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
            Define the data you want. KasGraph handles the indexing path.
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
          Not an Ethereum-shaped indexer pointed at Kaspa.
        </h2>
        <p className="mt-5 max-w-4xl text-lg leading-8 text-[#b7c9c5]">
          KasGraph is designed around UTXO state transitions, Covenant ID lineage, BlockDAG
          finality, KRC assets, and verifiable indexing output.
        </p>
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
            AI agents get tools, not scraped explorer pages.
          </h2>
          <p className="mt-5 text-lg leading-8 text-[#b7c9c5]">
            MCP is a first-class interface over the same indexed registry and gateway used by
            applications. Agents can discover schemas, execute queries, inspect Covenant ID lineage,
            and search detected Kaspa patterns with structured tool calls.
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
            Open-source core infrastructure, moving toward hosted validation.
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
    </main>
  );
}
