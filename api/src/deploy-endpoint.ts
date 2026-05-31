// Hosted-node deploy endpoint — the server side of `kasgraph deploy --node <url>`.
//
// A subgraph is deployed by writing its registry row (`kasgraph_subgraph`); the
// CLI can do that directly against Postgres (`--database-url`) or, in a hosted
// setup, POST a deploy bundle to a node which writes it. This module is that
// node-side write surface, kept as a pure request handler
// (`handleDeployRequest`) so it's testable without binding a socket, plus a
// thin Fetch-API adapter (`createDeployFetchHandler`) an operator can route
// `/subgraphs*` to alongside the GraphQL Yoga handler.
//
// Routes:
//   POST   /subgraphs        body = deploy bundle           -> 200 { subgraphId } | 400
//   GET    /subgraphs/:id                                   -> 200 { … } | 404
//   DELETE /subgraphs/:id                                   -> 200 { removed: true } | 404
//
// Auth:
//   Configure `KASGRAPH_DEPLOY_TOKEN` on public nodes. When set, POST and
//   DELETE require `Authorization: Bearer <token>`. GET stays public so
//   clients can inspect deployment status.

import { createHash } from 'node:crypto';

import { fetchSubgraphDeployment, type PgPoolLike } from './pg-resolvers.js';

const SUBGRAPH_ID_RE = /^[a-z0-9_]+$/;

/** The deploy bundle a client POSTs. Mirrors the CLI's `DeployBundle`. */
export interface DeploySubgraphInput {
  subgraphId: string;
  schemaSdl: string;
  manifestJson: unknown;
  wasmSha256?: string;
  /** The compiled mapping wasm, base64-encoded. When present it is persisted
   * (and, if `wasmSha256` is given too, integrity-checked against it). */
  wasmBase64?: string;
}

/** Validate + normalize a raw POST body into a `DeploySubgraphInput`, or return
 * a message describing the first problem. */
export function parseDeployBundle(
  raw: unknown,
): { input?: DeploySubgraphInput; error?: string } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'deploy bundle must be a JSON object' };
  }
  const b = raw as Record<string, unknown>;
  const subgraphId = b['subgraphId'];
  if (typeof subgraphId !== 'string' || !SUBGRAPH_ID_RE.test(subgraphId)) {
    return { error: 'subgraphId must match ^[a-z0-9_]+$' };
  }
  if (typeof b['schemaSdl'] !== 'string' || b['schemaSdl'].length === 0) {
    return { error: 'schemaSdl is required' };
  }
  if (b['manifestJson'] === undefined || b['manifestJson'] === null) {
    return { error: 'manifestJson is required' };
  }
  const wasmSha256 = b['wasmSha256'];
  if (wasmSha256 !== undefined && typeof wasmSha256 !== 'string') {
    return { error: 'wasmSha256 must be a string when present' };
  }
  const wasmBase64 = b['wasmBase64'];
  if (wasmBase64 !== undefined && typeof wasmBase64 !== 'string') {
    return { error: 'wasmBase64 must be a string when present' };
  }
  // Integrity: if the bytes and their declared hash are both present, they must
  // agree — catches a corrupted/mismatched upload before it's persisted.
  if (typeof wasmBase64 === 'string' && typeof wasmSha256 === 'string') {
    const actual = createHash('sha256').update(Buffer.from(wasmBase64, 'base64')).digest('hex');
    if (actual !== wasmSha256) {
      return { error: `wasm sha256 mismatch: bundle declares ${wasmSha256}, bytes hash to ${actual}` };
    }
  }
  return {
    input: {
      subgraphId,
      schemaSdl: b['schemaSdl'],
      manifestJson: b['manifestJson'],
      ...(typeof wasmSha256 === 'string' && { wasmSha256 }),
      ...(typeof wasmBase64 === 'string' && { wasmBase64 }),
    },
  };
}

/** Write (or overwrite) a subgraph's registry row — the same upsert the store's
 * `upsert_subgraph_deployment` and the CLI's direct-DB path use. */
export async function deploySubgraph(
  pool: PgPoolLike,
  input: DeploySubgraphInput,
): Promise<void> {
  const wasmBytes =
    input.wasmBase64 !== undefined ? Buffer.from(input.wasmBase64, 'base64') : null;
  await pool.query(
    `INSERT INTO kasgraph_subgraph (subgraph, schema_sdl, manifest_json, wasm_sha256, wasm_bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subgraph) DO UPDATE SET
       schema_sdl = EXCLUDED.schema_sdl,
       manifest_json = EXCLUDED.manifest_json,
       wasm_sha256 = EXCLUDED.wasm_sha256,
       wasm_bytes = EXCLUDED.wasm_bytes,
       status = 'active',
       deployed_at = NOW()`,
    [
      input.subgraphId,
      input.schemaSdl,
      JSON.stringify(input.manifestJson),
      input.wasmSha256 ?? null,
      wasmBytes,
    ],
  );
}

/** Soft-delete a subgraph; returns whether a live row was affected. */
export async function removeSubgraph(pool: PgPoolLike, subgraphId: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE kasgraph_subgraph SET status = 'removed'
     WHERE subgraph = $1 AND status <> 'removed'
     RETURNING subgraph`,
    [subgraphId],
  );
  return result.rows.length > 0;
}

export interface DeployRequest {
  method: string;
  /** Path portion only, e.g. `/subgraphs` or `/subgraphs/kasbonds`. */
  path: string;
  /** Parsed JSON body (POST), or `undefined`. */
  body?: unknown;
  /** Raw Authorization header, if the transport supplied one. */
  authorization?: string;
}

export interface DeployResponse {
  status: number;
  body: unknown;
}

export interface DeployAuthOptions {
  /** Bearer token required for POST/DELETE. Empty/undefined disables auth. */
  bearerToken?: string;
}

/** Pure deploy-endpoint handler. No socket, no framework — maps a parsed
 * request to a status + JSON body against the registry. */
export async function handleDeployRequest(
  req: DeployRequest,
  pool: PgPoolLike,
  auth: DeployAuthOptions = {},
): Promise<DeployResponse> {
  const segments = req.path.replace(/^\/+|\/+$/g, '').split('/');
  if (segments[0] !== 'subgraphs') {
    return { status: 404, body: { error: 'not found' } };
  }
  const id = segments[1];

  if (requiresAuth(req.method) && !isAuthorized(req.authorization, auth.bearerToken)) {
    return { status: 401, body: { error: 'unauthorized' } };
  }

  if (req.method === 'POST' && id === undefined) {
    const { input, error } = parseDeployBundle(req.body);
    if (input === undefined) return { status: 400, body: { error } };
    await deploySubgraph(pool, input);
    return { status: 200, body: { subgraphId: input.subgraphId, status: 'active' } };
  }

  if (id === undefined || !SUBGRAPH_ID_RE.test(id)) {
    return { status: 400, body: { error: 'invalid subgraph id' } };
  }

  if (req.method === 'GET') {
    const deployment = await fetchSubgraphDeployment(pool, id);
    if (deployment === null) return { status: 404, body: { error: 'not deployed' } };
    return {
      status: 200,
      body: {
        subgraphId: id,
        deployed: true,
        ...(deployment.wasmSha256 !== undefined && { wasmSha256: deployment.wasmSha256 }),
      },
    };
  }

  if (req.method === 'DELETE') {
    const removed = await removeSubgraph(pool, id);
    return removed
      ? { status: 200, body: { subgraphId: id, removed: true } }
      : { status: 404, body: { error: 'not deployed' } };
  }

  return { status: 405, body: { error: 'method not allowed' } };
}

/** Fetch-API adapter: a `(Request) => Promise<Response>` an operator routes
 * `/subgraphs*` to (e.g. before delegating other paths to the Yoga handler). */
export function createDeployFetchHandler(
  pool: PgPoolLike,
  auth: DeployAuthOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const authorization = request.headers.get('authorization') ?? undefined;
    if (requiresAuth(request.method) && !isAuthorized(authorization, auth.bearerToken)) {
      return jsonResponse(401, { error: 'unauthorized' });
    }

    let body: unknown;
    if (request.method === 'POST') {
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, { error: 'invalid JSON body' });
      }
    }
    const { pathname } = new URL(request.url);
    const res = await handleDeployRequest(
      {
        method: request.method,
        path: pathname,
        body,
        ...(authorization !== undefined && { authorization }),
      },
      pool,
      auth,
    );
    return jsonResponse(res.status, res.body);
  };
}

function requiresAuth(method: string): boolean {
  return method === 'POST' || method === 'DELETE';
}

function isAuthorized(authorization: string | undefined, token: string | undefined): boolean {
  if (token === undefined || token.length === 0) return true;
  return authorization === `Bearer ${token}`;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
