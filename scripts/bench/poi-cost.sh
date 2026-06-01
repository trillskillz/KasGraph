#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/benchmarks/$(date -u +%F)}"
mkdir -p "${out_dir}"

if [[ -z "${DATABASE_URL:-${KASGRAPH_DATABASE_URL:-}}" ]]; then
  printf '{"ts":"%s","status":"skipped","reason":"DATABASE_URL not set"}\n' "$(date -u +%FT%TZ)" > "${out_dir}/poi-cost.json"
  exit 0
fi

db_url="${DATABASE_URL:-${KASGRAPH_DATABASE_URL}}"
query="SELECT json_build_object(
  'latestDaa', (SELECT MAX(block_daa_score)::text FROM kasgraph_poi),
  'poiCheckpoints', (SELECT COUNT(*) FROM kasgraph_poi)
);"
psql "${db_url}" -Atc "${query}" > "${out_dir}/poi-cost.json"
