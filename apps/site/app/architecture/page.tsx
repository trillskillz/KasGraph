import { ArchitectureDiagram } from '@/components/ArchitectureDiagram';
import { FeatureCard } from '@/components/FeatureCard';
import { PageHero } from '@/components/PageHero';

const blocks: Array<[string, string]> = [
  ['Indexer node', 'The Rust node ingests Kaspa RPC/wRPC, applies detector events, dispatches WASM mappings, persists entity versions, and writes POI checkpoints.'],
  ['PostgreSQL store', 'Registry rows, migrations, per-subgraph schemas, lineage, entity state, reorg audit, and checkpoints live in Postgres.'],
  ['GraphQL gateway', 'The TypeScript API package serves base gateway types plus per-subgraph schemas generated from deployed schema.graphql files.'],
  ['MCP server', 'The MCP package delegates schema lookup and query execution to the same registry-aware gateway data plane.'],
  ['KasStream and WebSocket', 'Streaming primitives and subscriptions expose near-live events without duplicating indexer state.'],
  ['Proof of Indexing', 'POI hashes committed entity state per block so verifier code can detect divergence in published checkpoint chains.'],
];

export default function ArchitecturePage() {
  return (
    <main>
      <PageHero
        eyebrow="architecture"
        title="One Kaspa data plane with GraphQL, MCP, streaming, and verification surfaces."
        description="KasGraph separates the public product site from the hosted node. The node and API are long-running services backed by Rust, TypeScript, and managed Postgres."
      />
      <section className="section grid gap-8 lg:grid-cols-[1fr_1fr] lg:items-start">
        <ArchitectureDiagram />
        <div className="grid gap-4">
          {blocks.map(([title, description]) => (
            <FeatureCard description={description} key={title} title={title} />
          ))}
        </div>
      </section>
    </main>
  );
}
