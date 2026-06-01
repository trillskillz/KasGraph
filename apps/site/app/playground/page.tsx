import { PageHero } from '@/components/PageHero';

export default function PlaygroundPage() {
  return (
    <main>
      <PageHero
        eyebrow="playground"
        title="Hosted playground coming soon."
        description="KasGraph will link a live GraphQL playground after the hosted node, managed Postgres, deploy auth, and testnet soak have been validated."
      />
      <section className="section">
        <div className="panel rounded-lg p-7">
          <p className="leading-7 text-[#b7c9c5]">
            No fake endpoint is exposed here. Until the hosted API is live, use the local quickstart
            and run `kasgraph-api` against your own Postgres-backed node.
          </p>
        </div>
      </section>
    </main>
  );
}
