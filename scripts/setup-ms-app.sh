#!/usr/bin/env bash
# Creates an Entra ID app registration for the reorgable Microsoft Graph sync worker.
# Outputs MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID, and MS_USER_ID.
#
# Requirements:
#   - az login already done (az account show should succeed)
#   - The signed-in az account must have Application.ReadWrite.All + 
#     DelegatedPermissionGrant.ReadWrite.All, or Global Administrator role,
#     to grant admin consent programmatically.
#     If admin-consent fails, follow the manual instructions printed at the end.

set -euo pipefail

APP_NAME="reorgable-graph-sync"
GRAPH_API_ID="00000003-0000-0000-c000-000000000000"

echo "==> Checking az authentication..."
az account show --query "user.name" -o tsv

TENANT_ID=$(az account show --query tenantId -o tsv)
echo "==> Tenant: $TENANT_ID"

echo "==> Creating app registration: $APP_NAME ..."
APP_ID=$(az ad app create \
  --display-name "$APP_NAME" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
echo "    appId: $APP_ID"

echo "==> Ensuring service principal exists..."
if ! az ad sp show --id "$APP_ID" &>/dev/null; then
  az ad sp create --id "$APP_ID" --query id -o tsv
else
  echo "    Service principal already exists, skipping."
fi

echo "==> Looking up Graph permission UUIDs..."
# Tasks.Read.All, Tasks.ReadWrite.All, and Calendars.Read application permissions
TASKS_READ_ALL_ID=$(az ad sp show --id "$GRAPH_API_ID" \
  --query "appRoles[?value=='Tasks.Read.All'].id | [0]" -o tsv)
TASKS_READWRITE_ALL_ID=$(az ad sp show --id "$GRAPH_API_ID" \
  --query "appRoles[?value=='Tasks.ReadWrite.All'].id | [0]" -o tsv)
CALENDARS_READ_ID=$(az ad sp show --id "$GRAPH_API_ID" \
  --query "appRoles[?value=='Calendars.Read'].id | [0]" -o tsv)

echo "    Tasks.Read.All:       $TASKS_READ_ALL_ID"
echo "    Tasks.ReadWrite.All:  $TASKS_READWRITE_ALL_ID"
echo "    Calendars.Read:       $CALENDARS_READ_ID"

echo "==> Adding application permissions..."
az ad app permission add \
  --id "$APP_ID" \
  --api "$GRAPH_API_ID" \
  --api-permissions "${TASKS_READ_ALL_ID}=Role" "${TASKS_READWRITE_ALL_ID}=Role" "${CALENDARS_READ_ID}=Role"

echo "==> Granting admin consent (requires Global Admin or Privileged Role Admin)..."
if az ad app permission admin-consent --id "$APP_ID" 2>&1; then
  echo "    Admin consent granted."
else
  echo ""
  echo "  *** Admin consent could not be granted automatically. ***"
  echo "  Please complete it manually:"
  echo "  1. Open https://portal.azure.com"
  echo "  2. Navigate to: Entra ID -> App registrations -> $APP_NAME"
  echo "  3. Click 'API permissions' -> 'Grant admin consent for <your tenant>'"
  echo "  4. Confirm and wait for the green checkmarks."
  echo ""
fi

echo "==> Creating client secret..."
CLIENT_SECRET=$(az ad app credential reset \
  --id "$APP_ID" \
  --display-name "reorgable-worker" \
  --query password -o tsv)

echo "==> Fetching your user object ID..."
USER_ID=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")
if [[ -z "$USER_ID" ]]; then
  echo "    Could not auto-detect user ID (guest account or limited permissions)."
  echo "    Run: az ad user list --filter \"userPrincipalName eq 'your@email.com'\" --query '[].id' -o tsv"
  USER_ID="<SET MANUALLY>"
fi

echo ""
echo "============================================================"
echo "  App registration complete. Set these Cloudflare secrets:"
echo "============================================================"
echo "  MS_CLIENT_ID     = $APP_ID"
echo "  MS_CLIENT_SECRET = $CLIENT_SECRET"
echo "  MS_TENANT_ID     = $TENANT_ID"
echo "  MS_USER_ID       = $USER_ID"
echo ""
echo "  wrangler secret put MS_CLIENT_ID     -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put MS_CLIENT_SECRET -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put MS_TENANT_ID     -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put MS_USER_ID       -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put INGEST_URL       -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put INGEST_API_TOKEN -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo ""
echo "  # Shared secret for authenticating calls from the report worker to this worker:"
echo "  # Generate a random token, e.g.: openssl rand -hex 32"
echo "  wrangler secret put WORKER_TOKEN        -c workers/microsoft-graph-sync-worker/wrangler.toml"
echo "  wrangler secret put MS_GRAPH_WORKER_TOKEN -c workers/report-worker/wrangler.toml"
echo "  # (Both WORKER_TOKEN and MS_GRAPH_WORKER_TOKEN must be set to the same value)"
echo "============================================================"
