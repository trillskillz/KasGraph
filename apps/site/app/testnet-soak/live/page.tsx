import { LiveSoakDashboard } from '@/components/LiveSoakDashboard';
import type { SoakStatus } from '@/components/LiveSoakDashboard';
import { PageHero } from '@/components/PageHero';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const liveArtifactRoots = [
  path.resolve(process.cwd(), '../../docs/artifacts/sustained-run/live'),
  path.resolve(process.cwd(), 'public/docs/artifacts/sustained-run/live'),
];

function readLiveSummary(): SoakStatus | undefined {
  for (const root of liveArtifactRoots) {
    const summaryPath = path.join(root, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      return JSON.parse(readFileSync(summaryPath, 'utf8')) as SoakStatus;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function readLiveLogs(): string[] {
  for (const root of liveArtifactRoots) {
    const logPath = path.join(root, 'public-log-tail.jsonl');
    if (!existsSync(logPath)) continue;
    return readFileSync(logPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-100);
  }
  return [];
}

export default function LiveTestnetSoakPage() {
  const apiBaseUrl = process.env.NEXT_PUBLIC_KASGRAPH_SOAK_API_URL ?? '';
  const initialStatus = readLiveSummary();
  const initialLogs = readLiveLogs();

  return (
    <main>
      <PageHero
        eyebrow="live testnet soak"
        title="Live Testnet Soak"
        description="This static dashboard renders the latest public-safe soak artifact. If a live API endpoint is configured, the browser will refresh from it; otherwise the checked artifact remains the source of truth."
      />
      <LiveSoakDashboard apiBaseUrl={apiBaseUrl} initialLogs={initialLogs} initialStatus={initialStatus} />
    </main>
  );
}
