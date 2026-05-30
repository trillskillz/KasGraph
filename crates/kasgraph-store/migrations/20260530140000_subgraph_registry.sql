-- Deployed-subgraph registry.
--
-- `ensure_subgraph_schema` creates a subgraph's per-schema *data* tables, but
-- nothing recorded the subgraph's *identity* — its `schema.graphql` SDL and
-- manifest. The typed per-subgraph GraphQL surface (`executeSubgraphQuery` /
-- `get_schema`) needs the deployed SDL to build a subgraph's schema at query
-- time, and `status` / `remove` need a place to record deployment state. This
-- is that registry: one global row per deployed subgraph.
CREATE TABLE IF NOT EXISTS kasgraph_subgraph (
    subgraph     TEXT PRIMARY KEY,          -- the SubgraphId (also its Postgres schema name)
    schema_sdl   TEXT NOT NULL,             -- the subgraph's schema.graphql, verbatim
    manifest_json JSONB NOT NULL,           -- the parsed manifest (sources, mappings, …)
    wasm_sha256  TEXT,                       -- hash of the deployed mapping wasm, if built
    status       TEXT NOT NULL DEFAULT 'active',
    deployed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS kasgraph_subgraph_status_idx
    ON kasgraph_subgraph (status);
