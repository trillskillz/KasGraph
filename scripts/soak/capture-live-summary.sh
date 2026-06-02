#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
api_url="${KASGRAPH_API_URL:-http://127.0.0.1:4002}"
mkdir -p "${artifact_dir}"

tmp="$(mktemp "${artifact_dir}/summary.json.tmp.XXXXXX")"
trap 'rm -f "${tmp}"' EXIT

curl -fsS --max-time 10 "${api_url}/soak/status" > "${tmp}"
printf '\n' >> "${tmp}"
mv "${tmp}" "${artifact_dir}/summary.json"

if [[ "${KASGRAPH_SOAK_AUTO_PUBLISH_COMPLETION:-1}" == "1" ]]; then
  publish_output="$(bash scripts/soak/publish-live-soak-completion.sh 2>&1 || true)"
  printf '%s\n' "${publish_output}"
  if [[ "${KASGRAPH_SOAK_AUTO_DEPLOY_COMPLETION:-1}" == "1" ]] && [[ "${publish_output}" == Published\ completed\ soak\ docs* ]]; then
    if command -v vercel >/dev/null 2>&1; then
      vercel deploy --prod
    else
      echo "vercel CLI not found; completion docs were published but the website was not redeployed" >&2
    fi
  fi
fi
