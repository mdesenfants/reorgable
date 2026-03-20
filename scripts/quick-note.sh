#!/usr/bin/env bash
# Quick-capture a thought for tomorrow's daily brief.
#
# Usage:
#   npm run note "Remember to review the deploy logs"
#   npm run note "Ask Alex about Q2 budget" work
#
# Environment:
#   INGEST_URL        – ingest worker URL (default: https://reorgable-ingest.matt-desenfants.workers.dev)
#   INGEST_API_TOKEN  – auth token (required)

set -euo pipefail

TEXT="${1:?Usage: npm run note \"your thought here\" [tag]}"
TAG="${2:-quick-capture}"
URL="${INGEST_URL:-https://reorgable-ingest.matt-desenfants.workers.dev}"

PAYLOAD=$(jq -n \
  --arg text "$TEXT" \
  --arg tag "$TAG" \
  '{title: "Quick capture", text: $text, tags: [$tag]}')

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${URL}/ingest/note" \
  -H "Authorization: Bearer ${INGEST_API_TOKEN:?Set INGEST_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" -ge 200 ] && [ "$HTTP_CODE" -lt 300 ]; then
  echo "✓ Captured: $TEXT"
else
  echo "✗ Failed ($HTTP_CODE): $BODY" >&2
  exit 1
fi
