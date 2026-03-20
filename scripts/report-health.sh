#!/usr/bin/env bash
set -euo pipefail

# Quick health check for deployed report worker.
#
# Environment variables:
#   REPORT_URL       Base report worker URL.
#                    Default: https://reorgable-report.matt-desenfants.workers.dev
#   REPORT_API_TOKEN Optional bearer token for protected deployments.

REPORT_URL="${REPORT_URL:-https://reorgable-report.matt-desenfants.workers.dev}"
HEALTH_URL="${REPORT_URL%/}/health"

echo "[report-health] GET ${HEALTH_URL}"

if [[ -n "${REPORT_API_TOKEN:-}" ]]; then
  curl -sS -H "authorization: Bearer ${REPORT_API_TOKEN}" "$HEALTH_URL"
else
  curl -sS "$HEALTH_URL"
fi

echo
