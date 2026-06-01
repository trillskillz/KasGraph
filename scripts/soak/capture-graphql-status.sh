#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/testnet-soak/$(date -u +%F)}"
graphql_url="${KASGRAPH_GRAPHQL_URL:-${KASGRAPH_API_URL:-http://127.0.0.1:4000}/graphql}"
mkdir -p "${out_dir}"
ts="$(date -u +%FT%TZ)"

query='{"query":"query SoakStatus { committedBlocks(first: 1, orderBy: daaScore, orderDirection: desc) { subgraph daaScore blockHash committedAt } poiCheckpoints(first: 1) { subgraph blockDaaScore poiHashHex } }"}'
body="$(curl -fsS --max-time 15 -H 'content-type: application/json' --data "${query}" "${graphql_url}" 2>/dev/null || true)"

printf '{"ts":"%s","graphql":%s}\n' "${ts}" "$(if [[ -n "${body}" ]]; then printf '%s' "${body}"; else printf 'null'; fi)" >> "${out_dir}/public-graphql-status.jsonl"
