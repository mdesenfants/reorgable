#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

WORKER_INGEST_CONFIG="workers/ingest-worker/wrangler.toml"
WORKER_EMAIL_CONFIG="workers/email-worker/wrangler.toml"
WORKER_REPORT_CONFIG="workers/report-worker/wrangler.toml"
WORKER_MS_CONFIG="workers/microsoft-graph-sync-worker/wrangler.toml"

D1_NAME="daily_brief"
RAW_BUCKET="daily-brief-raw"
REPORT_BUCKET="daily-brief-reports"
KV_BINDING="STATE_KV"
KV_TITLE="STATE_KV"

say() {
  printf "\n%s\n" "$*"
}

warn() {
  printf "\n[WARN] %s\n" "$*"
}

die() {
  printf "\n[ERROR] %s\n" "$*"
  exit 1
}

confirm() {
  local prompt="$1"
  local default="${2:-y}"
  local hint="[Y/n]"
  if [[ "$default" == "n" ]]; then
    hint="[y/N]"
  fi

  read -r -p "$prompt $hint " reply
  reply="${reply:-$default}"
  [[ "$reply" =~ ^[Yy]$ ]]
}

require_cmd() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1 || die "Missing required command: $cmd"
}

json_find_id_by_name() {
  local json_input="$1"
  local target_name="$2"

  node -e '
const payload = process.argv[1];
const target = process.argv[2];
let items = [];
try { items = JSON.parse(payload); } catch { process.exit(1); }
for (const item of items) {
  const name = item.name ?? item.title ?? item.namespace ?? "";
  const id = item.id ?? item.database_id ?? item.namespace_id ?? "";
  if (name === target && id) {
    console.log(id);
    process.exit(0);
  }
}
process.exit(0);
' "$json_input" "$target_name"
}

set_secret() {
  local config="$1"
  local key="$2"
  local value="$3"

  printf "%s" "$value" | npx wrangler secret put "$key" -c "$config" >/dev/null
  echo "  - set $key on $(basename "$(dirname "$config")")"
}

update_wrangler_d1_id() {
  local new_id="$1"
  sed -i -E "s/(database_id = \").*(\")/\1${new_id}\2/" "$WORKER_INGEST_CONFIG"
  sed -i -E "s/(database_id = \").*(\")/\1${new_id}\2/" "$WORKER_REPORT_CONFIG"
}

update_wrangler_kv_id() {
  local new_id="$1"
  sed -i -E "s/(id = \").*(\")/\1${new_id}\2/" "$WORKER_REPORT_CONFIG"
}

ensure_d1() {
  say "Checking D1 database: $D1_NAME"
  local d1_json
  d1_json="$(npx wrangler d1 list --json)"
  local d1_id
  d1_id="$(json_find_id_by_name "$d1_json" "$D1_NAME")"

  if [[ -z "$d1_id" ]]; then
    say "Creating D1 database: $D1_NAME"
    npx wrangler d1 create "$D1_NAME" >/dev/null
    d1_json="$(npx wrangler d1 list --json)"
    d1_id="$(json_find_id_by_name "$d1_json" "$D1_NAME")"
  fi

  [[ -n "$d1_id" ]] || die "Could not resolve D1 database id for $D1_NAME"
  update_wrangler_d1_id "$d1_id"
  echo "  - D1 id: $d1_id"
}

ensure_r2_bucket() {
  local bucket_name="$1"
  say "Checking R2 bucket: $bucket_name"
  local buckets_json
  buckets_json="$(npx wrangler r2 bucket list --json)"
  local found
  found="$(node -e '
const payload = process.argv[1];
const target = process.argv[2];
let items = [];
try { items = JSON.parse(payload); } catch { process.exit(1); }
const yes = items.some((it) => (it.name ?? "") === target);
process.stdout.write(yes ? "yes" : "");
' "$buckets_json" "$bucket_name")"

  if [[ -z "$found" ]]; then
    say "Creating R2 bucket: $bucket_name"
    npx wrangler r2 bucket create "$bucket_name" >/dev/null
  fi

  echo "  - ready: $bucket_name"
}

ensure_kv_namespace() {
  say "Checking KV namespace: $KV_TITLE"
  local kv_json
  kv_json="$(npx wrangler kv namespace list --json)"
  local kv_id
  kv_id="$(json_find_id_by_name "$kv_json" "$KV_TITLE")"

  if [[ -z "$kv_id" ]]; then
    say "Creating KV namespace: $KV_TITLE"
    npx wrangler kv namespace create "$KV_BINDING" >/dev/null
    kv_json="$(npx wrangler kv namespace list --json)"
    kv_id="$(json_find_id_by_name "$kv_json" "$KV_TITLE")"
  fi

  [[ -n "$kv_id" ]] || die "Could not resolve KV namespace id for $KV_TITLE"
  update_wrangler_kv_id "$kv_id"
  echo "  - KV id: $kv_id"
}

run_migrations() {
  say "Running D1 migrations"
  local migration
  for migration in migrations/*.sql; do
    echo "  - applying $(basename "$migration")"
    npx wrangler d1 execute "$D1_NAME" --remote --file "$migration" >/dev/null
  done
}

capture_worker_url_from_deploy() {
  local deploy_output="$1"
  echo "$deploy_output" | grep -Eo 'https://[^ ]+\.workers\.dev' | head -1
}

setup_ms_sync() {
  if ! confirm "Set up Microsoft To Do + Outlook Calendar sync now?" "y"; then
    warn "Skipping Microsoft sync setup."
    return
  fi

  require_cmd az

  say "Checking Azure CLI login"
  if ! az account show >/dev/null 2>&1; then
    say "Azure CLI needs sign-in. A browser window may open now."
    az login >/dev/null
  fi

  say "Creating Azure app registration for Microsoft Graph"
  local ms_output
  ms_output="$(bash scripts/setup-ms-app.sh)"
  echo "$ms_output"

  local ms_client_id ms_client_secret ms_tenant_id ms_user_id
  ms_client_id="$(echo "$ms_output" | awk -F' = ' '/MS_CLIENT_ID/{print $2}' | tail -1)"
  ms_client_secret="$(echo "$ms_output" | awk -F' = ' '/MS_CLIENT_SECRET/{print $2}' | tail -1)"
  ms_tenant_id="$(echo "$ms_output" | awk -F' = ' '/MS_TENANT_ID/{print $2}' | tail -1)"
  ms_user_id="$(echo "$ms_output" | awk -F' = ' '/MS_USER_ID/{print $2}' | tail -1)"

  [[ -n "$ms_client_id" && -n "$ms_client_secret" && -n "$ms_tenant_id" && -n "$ms_user_id" ]] || {
    warn "Could not parse one or more Microsoft Graph values automatically."
    read -r -p "MS_CLIENT_ID: " ms_client_id
    read -r -p "MS_CLIENT_SECRET: " ms_client_secret
    read -r -p "MS_TENANT_ID: " ms_tenant_id
    read -r -p "MS_USER_ID: " ms_user_id
  }

  set_secret "$WORKER_MS_CONFIG" "MS_CLIENT_ID" "$ms_client_id"
  set_secret "$WORKER_MS_CONFIG" "MS_CLIENT_SECRET" "$ms_client_secret"
  set_secret "$WORKER_MS_CONFIG" "MS_TENANT_ID" "$ms_tenant_id"
  set_secret "$WORKER_MS_CONFIG" "MS_USER_ID" "$ms_user_id"
  set_secret "$WORKER_MS_CONFIG" "INGEST_URL" "$INGEST_URL"
  set_secret "$WORKER_MS_CONFIG" "INGEST_API_TOKEN" "$INGEST_TOKEN"

  say "Deploying microsoft-graph-sync-worker"
  local ms_deploy
  ms_deploy="$(npx wrangler deploy -c "$WORKER_MS_CONFIG")"
  echo "$ms_deploy"

  MS_SYNC_URL="$(capture_worker_url_from_deploy "$ms_deploy")"
  if [[ -n "$MS_SYNC_URL" ]]; then
    say "Testing Microsoft sync /run endpoint"
    node -e '
const url = process.argv[1] + "/run";
fetch(url, { method: "POST" }).then(async (res) => {
  console.log(await res.text());
}).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
' "$MS_SYNC_URL"
  fi
}

say "============================================================"
say "reorgable guided setup"
say "This script will set up resources, deploy workers, and test the stack."
say "============================================================"

require_cmd node
require_cmd npm
require_cmd npx

if ! confirm "Continue?" "y"; then
  die "Setup cancelled by user."
fi

say "Installing npm dependencies"
npm install

say "Checking Wrangler authentication"
if ! npx wrangler whoami >/dev/null 2>&1; then
  say "Wrangler needs sign-in. A browser window may open now."
  npx wrangler login
fi

ensure_d1
ensure_r2_bucket "$RAW_BUCKET"
ensure_r2_bucket "$REPORT_BUCKET"
ensure_kv_namespace
run_migrations

say "Generating ingest API token"
INGEST_TOKEN="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"

say "Configuring worker secrets"
set_secret "$WORKER_INGEST_CONFIG" "INGEST_API_TOKEN" "$INGEST_TOKEN"
set_secret "$WORKER_INGEST_CONFIG" "INGEST_API_TOKEN_ALT" "$INGEST_TOKEN"

read -r -p "Enter your Gemini API key (required): " GEMINI_API_KEY
[[ -n "$GEMINI_API_KEY" ]] || die "Gemini API key is required."
set_secret "$WORKER_REPORT_CONFIG" "GEMINI_API_KEY" "$GEMINI_API_KEY"

if confirm "Do you want to set REMARKABLE_DEVICE_TOKEN now?" "n"; then
  read -r -p "Enter REMARKABLE_DEVICE_TOKEN: " RM_TOKEN
  if [[ -n "$RM_TOKEN" ]]; then
    set_secret "$WORKER_REPORT_CONFIG" "REMARKABLE_DEVICE_TOKEN" "$RM_TOKEN"
  fi
fi

say "Deploying ingest-worker"
INGEST_DEPLOY_OUTPUT="$(npx wrangler deploy -c "$WORKER_INGEST_CONFIG")"
echo "$INGEST_DEPLOY_OUTPUT"
INGEST_URL="$(capture_worker_url_from_deploy "$INGEST_DEPLOY_OUTPUT")"
[[ -n "$INGEST_URL" ]] || die "Could not determine ingest worker URL from deploy output."

say "Configuring email-worker secrets"
set_secret "$WORKER_EMAIL_CONFIG" "INGEST_BASE_URL" "$INGEST_URL"
set_secret "$WORKER_EMAIL_CONFIG" "INGEST_API_TOKEN" "$INGEST_TOKEN"
if confirm "Configure optional EMAIL_FORWARD_TO for email-worker?" "n"; then
  read -r -p "Forward to email address: " FORWARD_TO
  if [[ -n "$FORWARD_TO" ]]; then
    set_secret "$WORKER_EMAIL_CONFIG" "EMAIL_FORWARD_TO" "$FORWARD_TO"
  fi
fi

say "Deploying email-worker"
EMAIL_DEPLOY_OUTPUT="$(npx wrangler deploy -c "$WORKER_EMAIL_CONFIG")"
echo "$EMAIL_DEPLOY_OUTPUT"

say "Deploying report-worker"
REPORT_DEPLOY_OUTPUT="$(npx wrangler deploy -c "$WORKER_REPORT_CONFIG")"
echo "$REPORT_DEPLOY_OUTPUT"
REPORT_URL="$(capture_worker_url_from_deploy "$REPORT_DEPLOY_OUTPUT")"

setup_ms_sync

say "Running smoke tests"
INGEST_URL="$INGEST_URL" INGEST_API_TOKEN="$INGEST_TOKEN" npm run test:ingest:note || warn "test:ingest:note failed"
if [[ -n "$REPORT_URL" ]]; then
  WORKER_URL="$REPORT_URL" npm run test:deployed || warn "test:deployed failed"
fi

say "============================================================"
say "Setup complete"
say "============================================================"
echo "Ingest URL:   $INGEST_URL"
echo "Report URL:   ${REPORT_URL:-<not detected>}"
echo "Ingest token: $INGEST_TOKEN"
if [[ -n "${MS_SYNC_URL:-}" ]]; then
  echo "MS Sync URL:  $MS_SYNC_URL"
fi

cat <<EOF

Next steps you can do later:
1) Google Apps Script: set INGEST_URL and INGEST_API_TOKEN in script properties.
2) Email Routing: point your route to reorgable-email worker.
3) reMarkable pairing (if skipped):
   REMARKABLE_ONE_TIME_CODE=XXXX-XXXX npm run remarkable:pair

EOF
