# KasGraph Hosted API

No public hosted API endpoint is currently committed in this repository. When a real endpoint exists, configure the site with:

```bash
NEXT_PUBLIC_KASGRAPH_GRAPHQL_URL=https://api.example.com/graphql
NEXT_PUBLIC_KASGRAPH_STATUS_URL=https://api.example.com/status
```

Do not set these values to mock endpoints.

## Required API Environment

- `DATABASE_URL` or `KASGRAPH_DATABASE_URL`
- `KASGRAPH_DEPLOY_TOKEN`
- `KASGRAPH_ENVIRONMENT`, for example `local` or `testnet`
- `KASGRAPH_NETWORK`, for example `kaspa-testnet-10`
- `GRAPHQL_ENDPOINT`, default `/graphql`
- `GRAPHIQL`, default enabled
- `KASGRAPH_SUBSCRIPTIONS_ENABLED`, default enabled

## Public Read Endpoints

- `GET /healthz`
- `GET /health`
- `GET /status`
- `GET /metrics`
- `POST /graphql` if public GraphQL reads are intended

## Protected Write Endpoints

- `POST /subgraphs`
- `DELETE /subgraphs/:id`

Protected writes require `Authorization: Bearer <KASGRAPH_DEPLOY_TOKEN>` when the token is configured.

## CORS And Query Limits

Before advertising a hosted endpoint, configure CORS for:

- `https://www.kasgraph.com`
- `https://kasgraph.com`
- local development origins used by maintainers

Add query timeouts, query-depth or complexity limits, and rate limiting before production claims.
