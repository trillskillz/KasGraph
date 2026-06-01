#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
mkdir -p "${artifact_dir}"
notes="${artifact_dir}/restart-recovery-events.jsonl"
ts="$(date -u +%FT%TZ)"

pre_status="$(curl -fsS --max-time 10 "${KASGRAPH_API_URL:-http://127.0.0.1:4000}/soak/status" 2>/dev/null || printf '{}')"
printf '{"timestamp":"%s","event":"restart_started","preStatus":%s}\n' "${ts}" "${pre_status}" >> "${notes}"

if [[ -n "${KASGRAPH_INDEXER_PID:-}" ]] && kill -0 "${KASGRAPH_INDEXER_PID}" 2>/dev/null; then
  kill "${KASGRAPH_INDEXER_PID}"
  wait "${KASGRAPH_INDEXER_PID}" 2>/dev/null || true
fi

if [[ -n "${KASGRAPH_INDEXER_CMD:-}" ]]; then
  bash -lc "${KASGRAPH_INDEXER_CMD}" >> "${artifact_dir}/raw-indexer-restart.log" 2>&1 &
  echo $! > "${artifact_dir}/indexer.pid"
fi

sleep "${RESTART_SETTLE_SECONDS:-15}"
post_status="$(curl -fsS --max-time 10 "${KASGRAPH_API_URL:-http://127.0.0.1:4000}/soak/status" 2>/dev/null || printf '{}')"
printf '{"timestamp":"%s","event":"restart_completed","postStatus":%s}\n' "$(date -u +%FT%TZ)" "${post_status}" >> "${notes}"
