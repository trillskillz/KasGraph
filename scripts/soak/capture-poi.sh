#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/testnet-soak/$(date -u +%F)}"
mkdir -p "${out_dir}"
ts="$(date -u +%FT%TZ)"

if [[ -z "${DATABASE_URL:-${KASGRAPH_DATABASE_URL:-}}" ]]; then
  printf '{"ts":"%s","status":"skipped","reason":"DATABASE_URL not set"}\n' "${ts}" >> "${out_dir}/public-poi-checkpoints.jsonl"
  exit 0
fi

db_url="${DATABASE_URL:-${KASGRAPH_DATABASE_URL}}"
query="SELECT json_build_object(
  'subgraph', subgraph,
  'blockDaaScore', block_daa_score::text,
  'poiHashHex', '0x' || encode(poi_hash, 'hex')
) FROM kasgraph_poi ORDER BY block_daa_score DESC LIMIT 1;"

body="$(psql "${db_url}" -Atc "${query}" 2>/dev/null || true)"
printf '{"ts":"%s","checkpoint":%s}\n' "${ts}" "$(if [[ -n "${body}" ]]; then printf '%s' "${body}"; else printf 'null'; fi)" >> "${out_dir}/public-poi-checkpoints.jsonl"
