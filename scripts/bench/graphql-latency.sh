#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/benchmarks/$(date -u +%F)}"
graphql_url="${KASGRAPH_GRAPHQL_URL:-${KASGRAPH_API_URL:-http://127.0.0.1:4000}/graphql}"
iterations="${BENCH_GRAPHQL_ITERATIONS:-25}"
mkdir -p "${out_dir}"
out="${out_dir}/graphql-latency.jsonl"
query='{"query":"query BenchCommittedBlocks { committedBlocks(first: 1, orderBy: daaScore, orderDirection: desc) { subgraph daaScore blockHash committedAt } }"}'

for i in $(seq 1 "${iterations}"); do
  start_ns="$(date +%s%N)"
  status="$(curl -sS -o /tmp/kasgraph-bench-graphql.json -w '%{http_code}' --max-time 15 -H 'content-type: application/json' --data "${query}" "${graphql_url}" || true)"
  end_ns="$(date +%s%N)"
  latency_ms=$(( (end_ns - start_ns) / 1000000 ))
  printf '{"ts":"%s","iteration":%s,"status":%s,"latencyMs":%s}\n' "$(date -u +%FT%TZ)" "${i}" "${status:-0}" "${latency_ms}" >> "${out}"
done
