#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/testnet-soak/$(date -u +%F)}"
mkdir -p "${out_dir}"

printf '{"ts":"%s","load":"%s","memory":"%s","disk":"%s"}\n' \
  "$(date -u +%FT%TZ)" \
  "$(uptime 2>/dev/null | sed 's/"/\\"/g' || true)" \
  "$(free -m 2>/dev/null | tr '\n' ';' | sed 's/"/\\"/g' || true)" \
  "$(df -h . 2>/dev/null | tail -1 | sed 's/"/\\"/g' || true)" \
  >> "${out_dir}/public-resource-metrics.jsonl"
