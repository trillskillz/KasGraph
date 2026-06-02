# Live Soak Dashboard

The live dashboard is available at `/testnet-soak/live`.

It does not generate demo values. It reads a configured live API base URL from:

```bash
NEXT_PUBLIC_KASGRAPH_SOAK_API_URL=https://your-api-host
```

If the variable is not set, the dashboard shows the soak as pending/not configured. If the endpoint is unreachable, it shows offline.

## Live API Endpoints

- `GET /soak/status`
- `GET /soak/metrics`
- `GET /soak/events`
- `GET /soak/logs`
- `GET /soak/summary`

`/soak/events` uses Server-Sent Events and emits `soak_status` snapshots from real API/Postgres/artifact state. The browser also polls `/soak/status` and `/soak/logs` as fallback.

## Status Values

- `pending`: no active live artifact exists.
- `running`: `summary.json` says a run is active.
- `degraded`: the run reports known health issues.
- `completed`: the run reached the 24-hour completion target or the summary was marked complete.
- `failed`: the run failed.
- `offline`: the browser cannot reach the live endpoint.

## Metric Sources

- Indexed DAA, indexed blocks, POI checkpoint count, and latest POI come from Postgres when available.
- Runtime, DAA start, commit, known issues, and restart verdict come from `summary.json`.
- Resource, DB, and log panels read sanitized public artifact files.
- Unknown metrics are returned as `null` and shown as unavailable.

## Log Sanitization

Public logs are sanitized before serving. The sanitizer redacts database URLs, bearer tokens, deploy tokens, API keys, passwords, connection strings, private RPC URLs, sensitive IPs, and local paths. Redacted values appear as `[REDACTED]`.

## Artifact Storage

Live artifacts are written to:

```text
docs/artifacts/sustained-run/live/
```

At run completion, archive reviewed artifacts to:

```text
docs/artifacts/sustained-run/YYYY-MM-DD/
```

When a non-failed run reaches 86,400 seconds, `scripts/soak/capture-live-summary.sh`
invokes `scripts/soak/publish-live-soak-completion.sh`. That publisher writes a dated
`docs/artifacts/testnet-soak/YYYY-MM-DD/summary.json`, marks the verdict as success,
updates the public report Markdown, and refreshes the website public artifact copy.

Do not commit raw logs.
