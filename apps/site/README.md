# KasGraph Site

Next.js + TypeScript + Tailwind CSS product site for `www.kasgraph.com`.

## Local commands

```bash
npm run site:dev
npm run site:build
npm run site:start
```

## Vercel deployment

Create a Vercel project from `https://github.com/trillskillz/KasGraph` with:

- Framework preset: Next.js
- Root directory: `apps/site`
- Install command: `npm install`
- Build command: `npm run build`
- Output directory: `.next`

Production domains:

- Primary: `www.kasgraph.com`
- Redirect: `kasgraph.com` -> `https://www.kasgraph.com`

Recommended DNS records from Vercel's standard setup:

| Host | Type | Value |
| --- | --- | --- |
| `www` | CNAME | `cname.vercel-dns.com` |
| `@` | A | `76.76.21.21` |

If Vercel asks for a TXT verification record, add the exact TXT name/value from the
Vercel dashboard before adding the production domains. Do not delete existing DNS
records unless they conflict with `www` or the apex website record.

## Backend/API deployment

The public website is intentionally separate from the hosted KasGraph node/API.
The API/indexer should run on Railway, Fly.io, Render, or a VPS with managed
Postgres, not on Vercel serverless.

Candidate subdomains:

- `api.kasgraph.com`
- `node.kasgraph.com`
- `mcp.kasgraph.com`

Required hosted-service environment variables:

```bash
DATABASE_URL=
KASGRAPH_INGEST_MODE=continuous
KASGRAPH_NOTIFICATION_WS_URL=
KASGRAPH_RPC_PRIMARY_URL=
KASGRAPH_RPC_BACKUP_URLS=
KASGRAPH_RELOAD_INTERVAL_SECS=30
KASGRAPH_WORK_DIR=
KASGRAPH_DEPLOY_TOKEN=
KASGRAPH_NODE_URL=
```

Keep all secrets in the deployment platform secret store. Never commit them.
