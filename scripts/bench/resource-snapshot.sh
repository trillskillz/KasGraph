#!/usr/bin/env bash
set -euo pipefail

out_dir="${1:-artifacts/benchmarks/$(date -u +%F)}"
mkdir -p "${out_dir}"

cpu_model="$(awk -F: '/model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null | xargs || true)"
mem_total="$(awk '/MemTotal/ {print $2 " " $3}' /proc/meminfo 2>/dev/null || true)"
disk="$(df -h . 2>/dev/null | tail -1 || true)"

cat > "${out_dir}/resource-snapshot.json" <<EOF_SNAPSHOT
{
  "ts": "$(date -u +%FT%TZ)",
  "cpu": "${cpu_model:-unavailable}",
  "memory": "${mem_total:-unavailable}",
  "disk": "${disk:-unavailable}",
  "os": "$(uname -a)"
}
EOF_SNAPSHOT
