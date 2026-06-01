#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
api_url="${KASGRAPH_API_URL:-http://127.0.0.1:4000}"
mkdir -p "${artifact_dir}"

curl -fsS --max-time 10 "${api_url}/soak/status" > "${artifact_dir}/summary.json"
printf '\n' >> "${artifact_dir}/summary.json"
