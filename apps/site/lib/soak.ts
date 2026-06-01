import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type SoakSummary = {
  status?: string;
  verdict?: string;
  network?: string;
  runDate?: string;
  startedAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  duration?: string;
  commit?: string;
  hostedEndpoint?: string;
  daaStart?: string | number | null;
  daaEnd?: string | number | null;
  blocksIndexed?: number | string | null;
  transactionsIndexed?: number | string | null;
  entitiesWritten?: number | string | null;
  poiCheckpoints?: number | string | null;
  restartRecoveryVerdict?: string;
  knownIssues?: string[] | string;
  publicLogs?: {
    indexer?: string;
    apiHealth?: string;
    poiCheckpoints?: string;
    dbStats?: string;
    restartNotes?: string;
  };
};

export type SoakView = {
  hasSummary: boolean;
  artifactDate?: string;
  summary?: SoakSummary;
};

const artifactRoot = path.resolve(process.cwd(), '../../docs/artifacts/testnet-soak');

export function getLatestSoakSummary(): SoakView {
  if (!existsSync(artifactRoot)) return { hasSummary: false };

  const datedDirs = readdirSync(artifactRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort()
    .reverse();

  for (const dir of datedDirs) {
    const summaryPath = path.join(artifactRoot, dir, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    try {
      return {
        hasSummary: true,
        artifactDate: dir,
        summary: JSON.parse(readFileSync(summaryPath, 'utf8')) as SoakSummary,
      };
    } catch {
      return {
        hasSummary: false,
        artifactDate: dir,
      };
    }
  }

  return { hasSummary: false };
}

export function soakValue(value: unknown, fallback = 'N/A'): string {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.length === 0 ? fallback : value.join('; ');
  return String(value);
}

export function formatDuration(summary: SoakSummary | undefined): string {
  if (summary?.duration !== undefined && summary.duration.length > 0) return summary.duration;
  if (summary?.durationSeconds === undefined) return 'N/A';
  const hours = summary.durationSeconds / 3600;
  if (hours >= 1) return `${hours.toFixed(1)} hours`;
  return `${summary.durationSeconds} seconds`;
}
