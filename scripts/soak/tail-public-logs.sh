#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
tail_count="${1:-100}"

if [[ -f "${artifact_dir}/public-log-tail.jsonl" ]]; then
  tail -n "${tail_count}" "${artifact_dir}/public-log-tail.jsonl"
else
  echo "No public log tail found at ${artifact_dir}/public-log-tail.jsonl" >&2
  exit 1
fi
