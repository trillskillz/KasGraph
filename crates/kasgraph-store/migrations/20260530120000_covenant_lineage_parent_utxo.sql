-- KIP-20 lineage: record the lineage *edge* per transition row.
--
-- The original single-head model implied a linear chain (seq 0,1,2,…), but
-- under the per-UTXO KCC20 model a `covenant_id` names the whole token and a
-- transfer forks it: one spent receipt produces ≥2 outputs that all inherit the
-- same `covenant_id`. Recording only `seq` makes those parallel branches look
-- like a single chain. `parent_utxo` is the spent predecessor UTXO
-- (`tx_hash:output_index`) this row transitioned from — NULL for a genesis. Two
-- outputs of one transfer share the same `parent_utxo`, so the branch structure
-- (a DAG, not a chain) is faithfully recorded; `seq` is now just a per-covenant
-- observation ordinal, no longer a claim of linear succession.
ALTER TABLE kasgraph_covenant_lineage_row
    ADD COLUMN IF NOT EXISTS parent_utxo TEXT;

-- Walking "the children of UTXO X" (forward lineage / successors) is a direct
-- lookup on the edge.
CREATE INDEX IF NOT EXISTS kasgraph_covenant_lineage_row_parent_idx
    ON kasgraph_covenant_lineage_row (covenant_id, parent_utxo);
