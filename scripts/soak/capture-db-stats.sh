#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/testnet-soak/$(date -u +%F)}"
mkdir -p "${out_dir}"
ts="$(date -u +%FT%TZ)"

if [[ -z "${DATABASE_URL:-${KASGRAPH_DATABASE_URL:-}}" ]]; then
  printf '{"ts":"%s","status":"skipped","reason":"DATABASE_URL not set"}\n' "${ts}" >> "${out_dir}/public-db-stats.jsonl"
  exit 0
fi

db_url="${DATABASE_URL:-${KASGRAPH_DATABASE_URL}}"
query="SELECT json_build_object(
  'committedBlocks', (SELECT COUNT(*) FROM kasgraph_committed_block),
  'indexedDaaScore', (SELECT MAX(daa_score)::text FROM kasgraph_committed_block),
  'poiCheckpoints', (SELECT COUNT(*) FROM kasgraph_poi),
  'subgraphs', (SELECT COUNT(*) FROM kasgraph_subgraph WHERE status <> 'removed')
);"

body="$(psql "${db_url}" -Atc "${query}" 2>/dev/null || true)"
printf '{"ts":"%s","db":%s}\n' "${ts}" "$(if [[ -n "${body}" ]]; then printf '%s' "${body}"; else printf 'null'; fi)" >> "${out_dir}/public-db-stats.jsonl"
