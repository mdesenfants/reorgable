#!/usr/bin/env bash
set -euo pipefail

# Force a manual report generation/upload run.
#
# Environment variables:
#   REPORT_URL         Base report worker URL.
#                      Default: https://reorgable-report.matt-desenfants.workers.dev
#   REPORT_API_TOKEN   Optional bearer token for protected deployments.
#   LOOKBACK_HOURS     Optional positive integer to include older context.
#                      Example: 72 includes items from last 72 hours.
#   SINCE_ISO          Optional ISO timestamp override for item cursor.
#                      Example: 2026-03-15T00:00:00Z
#   CURL_TIMEOUT_SEC   Curl max time in seconds (default: 120)
#
# Usage:
#   ./scripts/report-force.sh
#   REPORT_URL=https://... ./scripts/report-force.sh
#   REPORT_API_TOKEN=... ./scripts/report-force.sh

REPORT_URL="${REPORT_URL:?REPORT_URL is required. Set it to your deployed report worker URL, e.g. https://reorgable-report.<your-subdomain>.workers.dev}"
CURL_TIMEOUT_SEC="${CURL_TIMEOUT_SEC:-120}"
RUN_URL="${REPORT_URL%/}/run?force=true"

if [[ -n "${LOOKBACK_HOURS:-}" ]]; then
  RUN_URL+="&lookbackHours=${LOOKBACK_HOURS}"
fi

if [[ -n "${SINCE_ISO:-}" ]]; then
  RUN_URL+="&since=${SINCE_ISO}"
fi

echo "[report-force] POST ${RUN_URL}"

TMP_BODY="$(mktemp)"
trap 'rm -f "$TMP_BODY"' EXIT

CURL_ARGS=(
  -sS
  -X POST
  --max-time "$CURL_TIMEOUT_SEC"
  -H "content-type: application/json"
  -o "$TMP_BODY"
  -w "%{http_code}"
  "$RUN_URL"
)

if [[ -n "${REPORT_API_TOKEN:-}" ]]; then
  CURL_ARGS=(
    -sS
    -X POST
    --max-time "$CURL_TIMEOUT_SEC"
    -H "content-type: application/json"
    -H "authorization: Bearer ${REPORT_API_TOKEN}"
    -o "$TMP_BODY"
    -w "%{http_code}"
    "$RUN_URL"
  )
fi

HTTP_CODE="$(curl "${CURL_ARGS[@]}")"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "[report-force] ERROR: HTTP ${HTTP_CODE}"
  cat "$TMP_BODY"
  exit 1
fi

if command -v jq >/dev/null 2>&1; then
  OK="$(jq -r '.ok // empty' "$TMP_BODY")"
  SKIPPED="$(jq -r '.skipped // empty' "$TMP_BODY")"
  REPORT_KEY="$(jq -r '.reportKey // empty' "$TMP_BODY")"
  SOURCE_COUNT="$(jq -r '.sourceCount // empty' "$TMP_BODY")"
  CURSOR_USED="$(jq -r '.cursorUsed // empty' "$TMP_BODY")"
  ARCHIVE_ATTEMPTED="$(jq -r '.archive.attempted // empty' "$TMP_BODY")"
  ARCHIVE_OK="$(jq -r '.archive.archived // empty' "$TMP_BODY")"
  ARCHIVE_KEY="$(jq -r '.archive.sourceKey // empty' "$TMP_BODY")"
  ARCHIVE_MSG="$(jq -r '.archive.message // empty' "$TMP_BODY")"
  REMARKABLE_OK="$(jq -r '.remarkable.ok // empty' "$TMP_BODY")"
  REMARKABLE_MSG="$(jq -r '.remarkable.message // empty' "$TMP_BODY")"
  ERROR_MSG="$(jq -r '.error // empty' "$TMP_BODY")"

  if [[ -n "$ERROR_MSG" && "$ERROR_MSG" != "null" ]]; then
    echo "[report-force] ERROR: ${ERROR_MSG}"
    cat "$TMP_BODY"
    exit 1
  fi

  echo "[report-force] ok=${OK} skipped=${SKIPPED} sourceCount=${SOURCE_COUNT}"
  [[ -n "$CURSOR_USED" ]] && echo "[report-force] cursorUsed=${CURSOR_USED}"
  [[ -n "$REPORT_KEY" ]] && echo "[report-force] reportKey=${REPORT_KEY}"
  [[ -n "$ARCHIVE_ATTEMPTED" ]] && echo "[report-force] archive.attempted=${ARCHIVE_ATTEMPTED}"
  [[ -n "$ARCHIVE_OK" ]] && echo "[report-force] archive.archived=${ARCHIVE_OK}"
  [[ -n "$ARCHIVE_KEY" ]] && echo "[report-force] archive.sourceKey=${ARCHIVE_KEY}"
  [[ -n "$ARCHIVE_MSG" ]] && echo "[report-force] archive.message=${ARCHIVE_MSG}"
  [[ -n "$REMARKABLE_OK" ]] && echo "[report-force] remarkable.ok=${REMARKABLE_OK}"
  [[ -n "$REMARKABLE_MSG" ]] && echo "[report-force] remarkable.message=${REMARKABLE_MSG}"
else
  cat "$TMP_BODY"
fi
