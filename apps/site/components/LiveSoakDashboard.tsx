'use client';

import { useEffect, useMemo, useState } from 'react';

type SoakStatus = {
  status?: string;
  environment?: string | null;
  network?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  durationSeconds?: number | null;
  indexedDaaScore?: string | null;
  daaStart?: string | null;
  daaDelta?: string | null;
  indexedBlocks?: number | null;
  latestPoiCheckpoint?: string | null;
  rpcConnected?: boolean | string | null;
  postgresConnected?: boolean | null;
  graphqlHealthy?: boolean | null;
  mcpHealthy?: boolean | null;
  websocketHealthy?: boolean | null;
  restartRecovery?: string | null;
  knownIssues?: string[];
};

type LiveSoakDashboardProps = {
  apiBaseUrl: string;
};

export function LiveSoakDashboard({ apiBaseUrl }: Readonly<LiveSoakDashboardProps>) {
  const [status, setStatus] = useState<SoakStatus>({ status: apiBaseUrl ? 'offline' : 'pending' });
  const [logs, setLogs] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState('');
  const [endpointState, setEndpointState] = useState(apiBaseUrl ? 'connecting' : 'not configured');

  const base = useMemo(() => apiBaseUrl.replace(/\/+$/, ''), [apiBaseUrl]);

  useEffect(() => {
    if (!base || paused) return;
    let cancelled = false;

    async function poll(): Promise<void> {
      try {
        const res = await fetch(`${base}/soak/status`, { cache: 'no-store' });
        const body = (await res.json()) as SoakStatus;
        if (!cancelled) {
          setStatus(body);
          setEndpointState(res.ok ? 'connected' : 'degraded');
        }
      } catch {
        if (!cancelled) {
          setStatus({ status: 'offline' });
          setEndpointState('offline');
        }
      }
      try {
        const logUrl = `${base}/soak/logs?tail=100${level ? `&level=${encodeURIComponent(level)}` : ''}`;
        const res = await fetch(logUrl, { cache: 'no-store' });
        const body = (await res.json()) as { logs?: string[] };
        if (!cancelled) setLogs(body.logs ?? []);
      } catch {
        if (!cancelled) setLogs([]);
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [base, paused, level]);

  useEffect(() => {
    if (!base || paused || typeof EventSource === 'undefined') return;
    const events = new EventSource(`${base}/soak/events`);
    events.addEventListener('soak_status', (event) => {
      setStatus(JSON.parse((event as MessageEvent).data) as SoakStatus);
      setEndpointState('streaming');
    });
    events.onerror = () => setEndpointState('polling fallback');
    return () => events.close();
  }, [base, paused]);

  const runtimeTarget = 24 * 60 * 60;
  const runtimePct = Math.min(100, Math.round(((status.durationSeconds ?? 0) / runtimeTarget) * 100));

  return (
    <section className="section grid gap-8">
      <div className="panel rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">live endpoint</p>
            <h2 className="mt-3 text-2xl font-semibold text-[#f3fffc]">{base || 'No live endpoint configured'}</h2>
          </div>
          <span className="mono rounded-full border border-[#70C7BA]/25 px-3 py-1 text-xs uppercase tracking-[0.16em] text-[#70C7BA]">
            {endpointState}
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card label="Soak status" value={status.status ?? 'pending'} />
        <Card label="Network" value={status.network ?? 'Unavailable'} />
        <Card label="Runtime" value={formatDuration(status.durationSeconds)} />
        <Card label="Indexed DAA" value={status.indexedDaaScore ?? 'Unavailable'} />
        <Card label="DAA delta" value={status.daaDelta ?? 'Unavailable'} />
        <Card label="Indexed blocks" value={status.indexedBlocks ?? 'Unavailable'} />
        <Card label="Latest POI" value={status.latestPoiCheckpoint ?? 'Unavailable'} />
        <Card label="API health" value={status.graphqlHealthy ?? 'Unavailable'} />
        <Card label="RPC health" value={status.rpcConnected ?? 'Unavailable'} />
        <Card label="Postgres" value={status.postgresConnected ?? 'Unavailable'} />
      </div>

      <div className="panel rounded-lg p-6">
        <h2 className="text-2xl font-semibold text-[#f3fffc]">Progress</h2>
        <div className="mt-5 h-3 rounded-full bg-black/40">
          <div className="h-3 rounded-full bg-[#49EACB]" style={{ width: `${runtimePct}%` }} />
        </div>
        <p className="mt-3 text-sm text-[#a9bbb7]">{runtimePct}% of 24h minimum target</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="panel rounded-lg p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-2xl font-semibold text-[#f3fffc]">Live Logs</h2>
            <div className="flex gap-2">
              <select className="rounded-md border border-[#70C7BA]/22 bg-black/40 p-2 text-sm text-[#dffcf6]" onChange={(event) => setLevel(event.target.value)} value={level}>
                <option value="">all</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
              <button className="rounded-md border border-[#49EACB]/35 px-3 py-2 text-sm text-[#dffcf6]" onClick={() => setPaused((v) => !v)} type="button">
                {paused ? 'Resume' : 'Pause'}
              </button>
            </div>
          </div>
          <pre className="mono mt-5 max-h-96 overflow-auto rounded-lg border border-[#70C7BA]/18 bg-black/40 p-4 text-xs leading-6 text-[#d8fff7]">
            {logs.length > 0 ? logs.join('\n') : 'No public sanitized logs available.'}
          </pre>
        </div>
        <div className="panel rounded-lg p-6">
          <h2 className="text-2xl font-semibold text-[#f3fffc]">Restart / Recovery</h2>
          <div className="mt-5 grid gap-3">
            <Card label="Restart status" value={status.restartRecovery ?? 'Unavailable'} />
            <Card label="MCP" value={status.mcpHealthy ?? 'Unavailable'} />
            <Card label="WebSocket/KasStream" value={status.websocketHealthy ?? 'Unavailable'} />
            <Card label="Known issues" value={(status.knownIssues ?? []).join('; ') || 'None reported'} />
          </div>
        </div>
      </div>

      <div className="panel rounded-lg p-6">
        <h2 className="text-2xl font-semibold text-[#f3fffc]">Artifacts</h2>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          {['summary.json', 'public-log-tail.jsonl', 'public-poi-checkpoints.jsonl', 'public-db-stats.jsonl', 'public-resource-metrics.jsonl', 'restart-recovery-events.jsonl'].map((file) => (
            <a className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4 text-sm text-[#dffcf6]" href={`/docs/artifacts/sustained-run/live/${file}`} key={file}>
              {file}
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

function Card({ label, value }: Readonly<{ label: string; value: unknown }>) {
  return (
    <div className="rounded-lg border border-[#70C7BA]/18 bg-black/20 p-4">
      <p className="mono text-[11px] uppercase tracking-[0.16em] text-[#70C7BA]">{label}</p>
      <p className="mt-2 break-words text-sm text-[#eefefa]">{String(value)}</p>
    </div>
  );
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === undefined || seconds === null) return 'Unavailable';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
