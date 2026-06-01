#!/usr/bin/env bash
set -euo pipefail

export KASGRAPH_SOAK_ARTIFACT_DIR="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
export SOAK_ARTIFACT_DIR="${SOAK_ARTIFACT_DIR:-${KASGRAPH_SOAK_ARTIFACT_DIR}}"
mkdir -p "${KASGRAPH_SOAK_ARTIFACT_DIR}"

cat > "${KASGRAPH_SOAK_ARTIFACT_DIR}/summary.json" <<EOF_SUMMARY
{
  "status": "running",
  "environment": "${KASGRAPH_ENVIRONMENT:-testnet}",
  "network": "${KASGRAPH_NETWORK:-kaspa-testnet-10}",
  "startedAt": "$(date -u +%FT%TZ)",
  "updatedAt": "$(date -u +%FT%TZ)",
  "commit": "$(git rev-parse HEAD)",
  "version": "0.1.0",
  "daaStart": null,
  "knownIssues": []
}
EOF_SUMMARY

exec bash scripts/soak/run-testnet-soak.sh
