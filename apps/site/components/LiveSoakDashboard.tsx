'use client';

import { useEffect, useMemo, useState } from 'react';

export type SoakStatus = {
  status?: string;
  sourceStatus?: string;
  completionStatus?: string;
  verdict?: string;
  targetDurationSeconds?: number | null;
  targetReached?: boolean | null;
  environment?: string | null;
  network?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  durationSeconds?: number | null;
  indexedDaaScore?: string | null;
  daaStart?: string | null;
  daaDelta?: string | null;
  indexedDaaDelta?: string | null;
  indexedBlocks?: number | null;
  observedDaaScore?: string | null;
  observedRpcDaaDelta?: string | null;
  observedBlocks?: number | null;
  kaspadConnected?: boolean | null;
  kaspadVersion?: string | null;
  kaspadSynced?: boolean | null;
  kaspadDaaScore?: string | null;
  kaspadDaaDelta?: string | null;
  kaspadNetworkId?: string | null;
  kaspadPhase?: string | null;
  kaspadBlockCount?: string | null;
  kaspadHeaderCount?: string | null;
  kaspadPruningPointHash?: string | null;
  kaspadSinkHash?: string | null;
  kaspadTipCount?: number | null;
  kaspadVirtualParentCount?: number | null;
  kaspadPeerCount?: number | null;
  kaspadIbdPeerCount?: number | null;
  kaspadProtocolVersion10Peers?: number | null;
  kaspadProtocolVersion9Peers?: number | null;
  kaspadLastPingMsMax?: number | null;
  kaspadError?: string | null;
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
  initialStatus?: SoakStatus;
  initialLogs?: string[];
};

export function LiveSoakDashboard({ apiBaseUrl, initialStatus, initialLogs = [] }: Readonly<LiveSoakDashboardProps>) {
  const [status, setStatus] = useState<SoakStatus>(initialStatus ?? { status: apiBaseUrl ? 'offline' : 'pending' });
  const [logs, setLogs] = useState<string[]>(initialLogs);
  const [paused, setPaused] = useState(false);
  const [level, setLevel] = useState('');
  const [endpointState, setEndpointState] = useState(apiBaseUrl ? 'connecting' : initialStatus ? 'static artifact' : 'not configured');

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
  const shownStatus = displayStatus(status);

  return (
    <section className="section grid gap-8">
      <div className="panel rounded-lg p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="mono text-xs uppercase tracking-[0.24em] text-[#49EACB]">status source</p>
            <h2 className="mt-3 text-2xl font-semibold text-[#f3fffc]">{base || 'Published static artifact'}</h2>
          </div>
          <span className="mono rounded-full border border-[#70C7BA]/25 px-3 py-1 text-xs uppercase tracking-[0.16em] text-[#70C7BA]">
            {endpointState}
          </span>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <Card label="Soak status" value={shownStatus ?? 'pending'} />
        <Card label="Completion" value={status.completionStatus ?? 'in_progress'} />
        <Card label="Verdict" value={status.verdict ?? 'Incomplete: 24-hour testnet soak target has not been reached.'} />
        <Card label="Network" value={status.network ?? 'Unavailable'} />
        <Card label="Runtime" value={formatDuration(status.durationSeconds)} />
        <Card label="Indexed DAA" value={status.indexedDaaScore ?? 'Unavailable'} />
        <Card label="Indexed DAA delta" value={status.indexedDaaDelta ?? status.daaDelta ?? 'Unavailable'} />
        <Card label="Indexed blocks" value={status.indexedBlocks ?? 'Unavailable'} />
        <Card label="Observed RPC DAA" value={status.observedDaaScore ?? 'Unavailable'} />
        <Card label="Observed RPC DAA delta" value={status.observedRpcDaaDelta ?? 'Unavailable'} />
        <Card label="Observed RPC blocks" value={status.observedBlocks ?? 'Unavailable'} />
        <Card label="Kaspad version" value={status.kaspadVersion ?? 'Unavailable'} />
        <Card label="Kaspad synced" value={status.kaspadSynced ?? 'Unavailable'} />
        <Card label="Kaspad DAA" value={status.kaspadDaaScore ?? 'Unavailable'} />
        <Card label="Kaspad DAA delta" value={status.kaspadDaaDelta ?? 'Unavailable'} />
        <Card label="Kaspad network" value={status.kaspadNetworkId ?? 'Unavailable'} />
        <Card label="Kaspad phase" value={status.kaspadPhase ?? 'Unavailable'} />
        <Card label="Kaspad headers" value={status.kaspadHeaderCount ?? 'Unavailable'} />
        <Card label="Kaspad blocks" value={status.kaspadBlockCount ?? 'Unavailable'} />
        <Card label="Kaspad peers" value={status.kaspadPeerCount ?? 'Unavailable'} />
        <Card label="Kaspad IBD peers" value={status.kaspadIbdPeerCount ?? 'Unavailable'} />
        <Card label="Protocol v10 peers" value={status.kaspadProtocolVersion10Peers ?? 'Unavailable'} />
        <Card label="Protocol v9 peers" value={status.kaspadProtocolVersion9Peers ?? 'Unavailable'} />
        <Card label="Max peer ping ms" value={status.kaspadLastPingMsMax ?? 'Unavailable'} />
        <Card label="Tip count" value={status.kaspadTipCount ?? 'Unavailable'} />
        <Card label="Virtual parents" value={status.kaspadVirtualParentCount ?? 'Unavailable'} />
        <Card label="Pruning point" value={status.kaspadPruningPointHash ?? 'Unavailable'} />
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
        <p className="mt-3 text-sm text-[#a9bbb7]">{runtimePct}% of 24h target</p>
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
          {['summary.json', 'public-log-tail.jsonl', 'public-poi-checkpoints.jsonl', 'public-db-stats.jsonl', 'public-resource-metrics.jsonl', 'restart-recovery-notes.md'].map((file) => (
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

function displayStatus(status: SoakStatus): string | undefined {
  if (status.targetReached === true || status.status === 'completed') return 'completed';
  const delta = Number(status.daaDelta);
  const syncedAndMoving = status.status === 'active' && (status.kaspadSynced === true || delta > 0);
  return syncedAndMoving ? 'begun' : status.status;
}

function formatDuration(seconds: number | null | undefined): string {
  if (seconds === undefined || seconds === null) return 'Unavailable';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}
