#!/usr/bin/env bash
set -euo pipefail

artifact_dir="${KASGRAPH_SOAK_ARTIFACT_DIR:-docs/artifacts/sustained-run/live}"
mkdir -p "${artifact_dir}"

node -e '
const fs = require("fs");
const p = process.argv[1];
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.status = s.status === "failed" ? "failed" : "completed";
s.updatedAt = new Date().toISOString();
s.endedAt = s.updatedAt;
fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
' "${artifact_dir}/summary.json"

echo "Marked live soak completed in ${artifact_dir}/summary.json"
