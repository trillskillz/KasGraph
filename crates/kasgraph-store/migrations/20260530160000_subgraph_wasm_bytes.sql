-- Store the deployed mapping's wasm *bytes* in the registry, not just the hash.
--
-- The control plane already records each subgraph's SDL + manifest + wasm hash.
-- For a node to actually run a deployed mapping it needs the wasm itself; the
-- registry is the cross-process source of truth both the TS gateway (which
-- accepts deploys) and the Rust node (which loads mappings) already share, so
-- the bytes live here too. Nullable: a metadata-only registration (or a legacy
-- row) carries no bytes. (Swappable for an object-store pointer later if
-- mappings grow large; for KB–low-MB wasm a BYTEA column is the simplest
-- topology with no shared-volume / co-location assumptions.)
ALTER TABLE kasgraph_subgraph
    ADD COLUMN IF NOT EXISTS wasm_bytes BYTEA;
