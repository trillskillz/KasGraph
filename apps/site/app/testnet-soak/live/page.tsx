import { LiveSoakDashboard } from '@/components/LiveSoakDashboard';
import { PageHero } from '@/components/PageHero';

export default function LiveTestnetSoakPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_KASGRAPH_SOAK_API_URL ?? '';

  return (
    <main>
      <PageHero
        eyebrow="live testnet soak"
        title="Live Testnet Soak"
        description="This dashboard reads public-safe live soak endpoints when configured. If no soak is running or no endpoint is configured, it shows pending, offline, or unavailable instead of demo values."
      />
      <LiveSoakDashboard apiBaseUrl={apiBaseUrl} />
    </main>
  );
}
