#!/usr/bin/env bash
set -euo pipefail

# Alias kept for operator language in docs. The sustained testnet run uses the
# same capture loop as the soak harness.
exec bash scripts/soak/run-testnet-soak.sh "$@"
