#!/usr/bin/env bash
set -euo pipefail

BENCH_DATE="${BENCH_DATE:-$(date -u +%F)}"
BENCH_DIR="${BENCH_DIR:-artifacts/benchmarks/${BENCH_DATE}}"
mkdir -p "${BENCH_DIR}"

bash scripts/bench/graphql-latency.sh "${BENCH_DIR}"
bash scripts/bench/db-growth.sh "${BENCH_DIR}" || true
bash scripts/bench/poi-cost.sh "${BENCH_DIR}" || true
bash scripts/bench/resource-snapshot.sh "${BENCH_DIR}" || true

cat > "${BENCH_DIR}/summary.json" <<EOF_SUMMARY
{
  "status": "captured",
  "date": "$(date -u +%FT%TZ)",
  "commit": "$(git rev-parse HEAD)",
  "artifactDir": "${BENCH_DIR}",
  "notes": "Review raw outputs before copying sanitized results into docs/artifacts/benchmarks/."
}
EOF_SUMMARY
