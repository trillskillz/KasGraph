import { DemoPreview } from '@/components/DemoPreview';
import { PageHero } from '@/components/PageHero';
import { PlaygroundClient } from '@/components/PlaygroundClient';

export default function PlaygroundPage() {
  const graphqlUrl = process.env.NEXT_PUBLIC_KASGRAPH_GRAPHQL_URL ?? '';
  const statusUrl = process.env.NEXT_PUBLIC_KASGRAPH_STATUS_URL ?? '';
  const hasEndpoint = graphqlUrl.length > 0;

  return (
    <main>
      <PageHero
        eyebrow="playground"
        title={hasEndpoint ? 'KasGraph GraphQL playground.' : 'Hosted playground coming soon.'}
        description={
          hasEndpoint
            ? 'This page connects to the configured GraphQL endpoint and keeps testnet/mainnet maturity explicit. Query failures are shown in place.'
            : 'KasGraph will link a live GraphQL playground after the hosted node, managed Postgres, deploy auth, and testnet soak have been validated.'
        }
      />
      <PlaygroundClient graphqlUrl={graphqlUrl} statusUrl={statusUrl} />
      <DemoPreview />
    </main>
  );
}
