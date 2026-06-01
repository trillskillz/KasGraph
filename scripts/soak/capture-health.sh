#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/testnet-soak/$(date -u +%F)}"
api_url="${KASGRAPH_API_URL:-http://127.0.0.1:4000}"
mkdir -p "${out_dir}"

ts="$(date -u +%FT%TZ)"
status_body="$(curl -fsS --max-time 10 "${api_url}/status" 2>/dev/null || true)"
health_body="$(curl -fsS --max-time 10 "${api_url}/healthz" 2>/dev/null || true)"

printf '{"ts":"%s","status":%s,"healthz":%s}\n' \
  "${ts}" \
  "$(if [[ -n "${status_body}" ]]; then printf '%s' "${status_body}"; else printf 'null'; fi)" \
  "$(if [[ -n "${health_body}" ]]; then printf '%s' "${health_body}"; else printf 'null'; fi)" \
  >> "${out_dir}/public-api-health.jsonl"
