#!/usr/bin/env bash
set -euo pipefail

SOAK_DATE="${SOAK_DATE:-$(date -u +%F)}"
SOAK_ARTIFACT_DIR="${SOAK_ARTIFACT_DIR:-artifacts/testnet-soak/${SOAK_DATE}}"
SOAK_DURATION_SECONDS="${SOAK_DURATION_SECONDS:-86400}"
SOAK_INTERVAL_SECONDS="${SOAK_INTERVAL_SECONDS:-60}"
KASGRAPH_API_URL="${KASGRAPH_API_URL:-http://127.0.0.1:4000}"
KASGRAPH_GRAPHQL_URL="${KASGRAPH_GRAPHQL_URL:-${KASGRAPH_API_URL}/graphql}"
KASGRAPH_INDEXER_CMD="${KASGRAPH_INDEXER_CMD:-cargo run -p kasgraph-node}"
KASGRAPH_API_CMD="${KASGRAPH_API_CMD:-node api/dist/main.js}"

mkdir -p "${SOAK_ARTIFACT_DIR}"

raw_indexer="${SOAK_ARTIFACT_DIR}/raw-indexer.log"
raw_api="${SOAK_ARTIFACT_DIR}/raw-api.log"
summary="${SOAK_ARTIFACT_DIR}/summary.json"
notes="${SOAK_ARTIFACT_DIR}/restart-recovery-notes.md"

commit="$(git rev-parse HEAD)"
start_time="$(date -u +%FT%TZ)"
end_epoch=$(( $(date +%s) + SOAK_DURATION_SECONDS ))

cleanup() {
  if [[ -n "${indexer_pid:-}" ]] && kill -0 "${indexer_pid}" 2>/dev/null; then
    kill "${indexer_pid}" 2>/dev/null || true
    wait "${indexer_pid}" 2>/dev/null || true
  fi
  if [[ -n "${api_pid:-}" ]] && kill -0 "${api_pid}" 2>/dev/null; then
    kill "${api_pid}" 2>/dev/null || true
    wait "${api_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Starting API: ${KASGRAPH_API_CMD}" >> "${raw_api}"
bash -lc "${KASGRAPH_API_CMD}" >> "${raw_api}" 2>&1 &
api_pid=$!

echo "Starting indexer: ${KASGRAPH_INDEXER_CMD}" >> "${raw_indexer}"
bash -lc "${KASGRAPH_INDEXER_CMD}" >> "${raw_indexer}" 2>&1 &
indexer_pid=$!

cat > "${notes}" <<EOF_NOTES
# Restart / Recovery Notes

Date: ${start_time}
Commit: ${commit}
Network: ${KASGRAPH_NETWORK:-Not set}
Pre-restart DAA: Not captured yet
Pre-restart POI: Not captured yet
Restart time: Not run yet
Post-restart DAA: Not captured yet
Post-restart POI: Not captured yet
Recovery duration: Not measured yet
RPC reconnect result: Not measured yet
Postgres reconnect result: Not measured yet
Gap recovery result: Not measured yet
POI continuity result: Not measured yet
Issues observed: Not measured yet
Fixes required: Not measured yet
Verdict: Incomplete until controlled restart is executed
EOF_NOTES

while [[ "$(date +%s)" -lt "${end_epoch}" ]]; do
  bash scripts/soak/capture-health.sh "${SOAK_ARTIFACT_DIR}" || true
  bash scripts/soak/capture-db-stats.sh "${SOAK_ARTIFACT_DIR}" || true
  bash scripts/soak/capture-poi.sh "${SOAK_ARTIFACT_DIR}" || true
  bash scripts/soak/capture-graphql-status.sh "${SOAK_ARTIFACT_DIR}" || true
  bash scripts/soak/capture-resource-metrics.sh "${SOAK_ARTIFACT_DIR}" || true
  sleep "${SOAK_INTERVAL_SECONDS}"
done

end_time="$(date -u +%FT%TZ)"
cat > "${summary}" <<EOF_SUMMARY
{
  "status": "completed_capture_window",
  "commit": "${commit}",
  "network": "${KASGRAPH_NETWORK:-unknown}",
  "startedAt": "${start_time}",
  "endedAt": "${end_time}",
  "durationSeconds": ${SOAK_DURATION_SECONDS},
  "artifactDir": "${SOAK_ARTIFACT_DIR}",
  "apiUrl": "${KASGRAPH_API_URL}",
  "graphqlUrl": "${KASGRAPH_GRAPHQL_URL}",
  "notes": "Review raw logs, run sanitizer, perform restart notes update, and publish only sanitized artifacts."
}
EOF_SUMMARY
