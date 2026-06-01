'use client';

import { useEffect, useMemo, useState } from 'react';

type StatusBody = {
  status?: string;
  environment?: string | null;
  network?: string | null;
  indexedDaaScore?: string | null;
  indexedBlocks?: number | null;
  latestPoiCheckpoint?: string | null;
  postgresConnected?: boolean | null;
  updatedAt?: string | null;
};

type LiveState = 'preview' | 'live' | 'degraded';

type DemoStatusClientProps = {
  statusUrl: string;
  graphqlUrl: string;
};

export function DemoStatusClient({ statusUrl, graphqlUrl }: Readonly<DemoStatusClientProps>) {
  const [state, setState] = useState<LiveState>(statusUrl.length > 0 ? 'degraded' : 'preview');
  const [status, setStatus] = useState<StatusBody | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (statusUrl.length === 0) {
      setState('preview');
      setStatus(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);

    fetch(statusUrl, { signal: controller.signal, cache: 'no-store' })
      .then(async (res) => {
        const body = (await res.json()) as StatusBody;
        setStatus(body);
        setError(null);
        setState(res.ok && body.status === 'ok' ? 'live' : 'degraded');
      })
      .catch((err: unknown) => {
        setStatus(null);
        setError(err instanceof Error ? err.message : String(err));
        setState('degraded');
      })
      .finally(() => window.clearTimeout(timer));

    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [statusUrl]);

  const label = useMemo(() => {
    if (state === 'live') return 'Live Testnet';
    if (state === 'degraded') return statusUrl.length > 0 ? 'Degraded' : 'Local-first';
    return 'Preview';
  }, [state, statusUrl]);

  return (
    <div className="panel rounded-lg p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="mono text-xs uppercase tracking-[0.2em] text-[#70C7BA]">endpoint state</span>
        <span
          className={`mono rounded-full border px-3 py-1 text-xs uppercase tracking-[0.16em] ${
            state === 'live'
              ? 'border-[#49EACB]/50 text-[#49EACB]'
              : state === 'degraded'
                ? 'border-[#ffb4a8]/35 text-[#ffb4a8]'
                : 'border-[#70C7BA]/22 text-[#a9bbb7]'
          }`}
        >
          {label}
        </span>
      </div>
      <div className="mt-4 grid gap-3 text-sm text-[#b7c9c5] sm:grid-cols-2 lg:grid-cols-4">
        <StatusValue label="Network" value={status?.network ?? status?.environment ?? 'preview'} />
        <StatusValue label="Indexed DAA" value={status?.indexedDaaScore ?? 'unavailable'} />
        <StatusValue label="POI" value={status?.latestPoiCheckpoint ?? 'unavailable'} />
        <StatusValue label="GraphQL" value={graphqlUrl.length > 0 ? graphqlUrl : 'not configured'} />
      </div>
      {error ? (
        <p className="mt-4 text-sm leading-6 text-[#ffb4a8]">
          Status check failed. The page remains in preview mode until a configured endpoint responds:
          {' '}
          {error}
        </p>
      ) : null}
      {status?.updatedAt ? (
        <p className="mono mt-4 text-xs uppercase tracking-[0.16em] text-[#8fb4ad]">
          Last status update: {status.updatedAt}
        </p>
      ) : null}
    </div>
  );
}

function StatusValue({ label, value }: Readonly<{ label: string; value: string | number }>) {
  return (
    <div className="rounded-md border border-[#70C7BA]/18 bg-black/20 p-3">
      <p className="mono text-[11px] uppercase tracking-[0.16em] text-[#70C7BA]">{label}</p>
      <p className="mt-2 break-words text-[#eefefa]">{value}</p>
    </div>
  );
}
