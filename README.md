# reorgable

A Cloudflare-based personal daily-briefing system. Throughout the day, tasks, notes, and emails are ingested and stored. Each morning, a scheduled worker summarizes everything with Gemini, renders a two-page PDF, and uploads it to your reMarkable tablet — ready to read with your coffee.

## How it works

```
Google Tasks ──► Google Apps Script ──┐
curl / shortcut ──────────────────────┼──► ingest-worker (D1 + R2)
Email Routing ──► email-worker ────────┘
                                            │
                                     (cron: 12:00 UTC)
                                            │
                                        report-worker
                                            │
                                      Gemini API (summarize)
                                            │
                                      Puppeteer (render PDF)
                                            │
                                      reMarkable cloud upload
```

Three Cloudflare Workers:

| Worker | Name | Purpose |
|---|---|---|
| `workers/ingest-worker` | `reorgable-ingest` | Authenticated REST API for all ingestion |
| `workers/email-worker` | `reorgable-email` | Receives Cloudflare Email Routing events, stores EML to R2, forwards metadata to ingest |
| `workers/report-worker` | `reorgable-report` | Scheduled report pipeline: summarize → render → upload |

Cloudflare resources used:

| Resource | Name | Used by |
|---|---|---|
| D1 database | `daily_brief` | ingest-worker, report-worker |
| R2 bucket | `daily-brief-raw` | ingest-worker (notes/docs), email-worker (EML) |
| R2 bucket | `daily-brief-reports` | report-worker (rendered PDFs) |
| KV namespace | `STATE_KV` | report-worker (last run cursor) |
| Browser Rendering | — | report-worker (Puppeteer PDF render) |

## Project layout

```
migrations/          D1 schema migrations
packages/
  shared/            Common Zod schemas and TypeScript types
scripts/
  google-apps-script-task-push.gs      Template for Google Tasks → ingest
  google-apps-script-task-push.deployed.gs  Reference copy of deployed script
  preview-report.ts  Local PDF preview (Puppeteer)
  remarkable-pair.mjs  One-time device pairing helper
  report-force.sh    Manually trigger a report run
  report-health.sh   Check report worker health
  test-deployed.ts   Smoke-test the deployed ingest worker
  test-ingest-note.ts  Smoke-test the note endpoint
workers/
  ingest-worker/     src/index.ts — all /ingest/* routes
  email-worker/      src/index.ts — email routing handler
  report-worker/     src/index.ts — cron handler + /run + /health
    remarkable/      reMarkable upload adapters
```

---

## First-time setup

### Prerequisites

- [Node.js](https://nodejs.org) ≥ 20 and npm ≥ 10
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) v4+ (`npm install -g wrangler`)
- A Cloudflare account with Workers, D1, R2, KV, and Browser Rendering enabled
- A [Google AI Studio](https://aistudio.google.com/) API key for Gemini
- A reMarkable tablet (optional — reports still generate without one)

### 1. Clone and install

```bash
git clone https://github.com/mdesenfants/reorgable.git
cd reorgable
npm install
```

### 2. Authenticate Wrangler

```bash
wrangler login
```

### 3. Create Cloudflare resources

Create the D1 database:

```bash
wrangler d1 create daily_brief
```

Update the `database_id` in both `workers/ingest-worker/wrangler.toml` and `workers/report-worker/wrangler.toml` with the ID printed by the command above.

Create the R2 buckets:

```bash
wrangler r2 bucket create daily-brief-raw
wrangler r2 bucket create daily-brief-reports
```

Create the KV namespace:

```bash
wrangler kv namespace create STATE_KV
```

Update the `id` in `workers/report-worker/wrangler.toml` with the ID printed above.

### 4. Run database migrations

```bash
wrangler d1 execute daily_brief --remote --file migrations/0001_init.sql
```

### 5. Set secrets

**ingest-worker** — choose a strong random token:

```bash
printf "%s" "<your-ingest-api-token>" | wrangler secret put INGEST_API_TOKEN \
  --config workers/ingest-worker/wrangler.toml
```

**email-worker**:

```bash
printf "%s" "<your-ingest-worker-url>" | wrangler secret put INGEST_BASE_URL \
  --config workers/email-worker/wrangler.toml

printf "%s" "<your-ingest-api-token>" | wrangler secret put INGEST_API_TOKEN \
  --config workers/email-worker/wrangler.toml

# Optional — forward accepted emails after ingest
printf "%s" "<forward-to-address>" | wrangler secret put EMAIL_FORWARD_TO \
  --config workers/email-worker/wrangler.toml
```

**report-worker**:

```bash
printf "%s" "<your-gemini-api-key>" | wrangler secret put GEMINI_API_KEY \
  --config workers/report-worker/wrangler.toml

# Optional — override the default model (gemini-3-flash-preview)
printf "%s" "gemini-3-flash-preview" | wrangler secret put GEMINI_MODEL \
  --config workers/report-worker/wrangler.toml
```

### 6. Pair reMarkable (optional)

Get a one-time code from [my.remarkable.com](https://my.remarkable.com) → Device management → Connect a device.

```bash
REMARKABLE_ONE_TIME_CODE=XXXX-XXXX npm run remarkable:pair
```

Store the returned device token:

```bash
printf "%s" "<device-token>" | wrangler secret put REMARKABLE_DEVICE_TOKEN \
  --config workers/report-worker/wrangler.toml
```

### 7. Deploy

```bash
wrangler deploy --config workers/ingest-worker/wrangler.toml
wrangler deploy --config workers/email-worker/wrangler.toml
npm run deploy:report
```

`deploy:report` uses `--minify` for the report worker because its bundle is large.

### 8. Configure Email Routing (optional)

In the Cloudflare dashboard, add an Email Routing rule that forwards incoming mail to your `reorgable-email` worker. Set a filter address (e.g. `brief@yourdomain.com`) that you can forward to from other services.

### 9. Smoke test

```bash
INGEST_URL=https://<your-ingest-worker>.workers.dev \
INGEST_API_TOKEN=<your-token> \
npm run test:ingest:note

INGEST_URL=https://<your-ingest-worker>.workers.dev \
INGEST_API_TOKEN=<your-token> \
npm run test:deployed
```

---

## npm scripts

| Script | Description |
|---|---|
| `typecheck` | Run `tsc --noEmit` across all packages |
| `dev:ingest` | Start ingest-worker locally with Wrangler |
| `dev:email` | Start email-worker locally with Wrangler |
| `dev:report` | Start report-worker locally with Wrangler |
| `remarkable:pair` | Run the one-time reMarkable pairing helper |
| `preview` | Render a local report PDF with Puppeteer (writes to `output/`) |
| `deploy:report` | Deploy the report-worker with minification |
| `report:health` | GET `/health` on the deployed report worker |
| `report:force` | POST `/run?force=true` on the deployed report worker |
| `test:deployed` | Smoke-test the deployed ingest worker endpoints |
| `test:ingest:note` | POST a test note to the deployed ingest worker |

---

## API reference

All ingest routes require `Authorization: Bearer <INGEST_API_TOKEN>`.

### `POST /ingest/task`

Ingest a task from any source (Google Tasks, Reminders, etc.).

```json
{
  "title": "Follow up on Q2 budget",
  "notes": "Ask Alex — she has the spreadsheet",
  "due": "2026-03-25T00:00:00Z",
  "isDone": false,
  "externalId": "tasks-abc123",
  "source": "google-tasks"
}
```

### `POST /ingest/email`

Ingest email metadata (used internally by the email-worker).

```json
{
  "subject": "Re: Q2 planning",
  "from": "alice@example.com",
  "snippet": "Happy to connect Thursday",
  "isStarred": true,
  "externalId": "gmail-thread-xyz",
  "source": "gmail"
}
```

### `POST /ingest/note`

Drop a freeform note or quick capture.

```json
{
  "title": "Quick capture",
  "text": "Remember to ask Alex about Q2 budget",
  "tags": ["work", "follow-up"],
  "externalId": "quick-note-2026-03-19-01"
}
```

### `POST /run` (report-worker)

Manually trigger a report run. Accepts optional query params:
- `force=true` — skip the time-of-day guard
- `lookbackHours=72` — include items up to N hours old regardless of cursor
- `since=2026-03-15T00:00:00Z` — set an explicit item cursor

### `GET /health` (report-worker)

Returns current worker state including last run timestamp and item count.

---

## Deduplication and relevancy

Ingestion deduplicates by `idempotency_key` (derived from `source` + `externalId` when provided). On duplicate ingest, records are updated in place.

Relevancy refresh rules:

- **Tasks**: `isDone=false` bumps the relevancy timestamp so unresolved tasks reappear in future briefs. `isDone=true` updates content without bumping it.
- **Email**: `isStarred=true` bumps relevancy. `isStarred=false` updates content only.

For reliable dedup, always send stable `externalId` values from source systems.

---

## Google Tasks integration

Template: `scripts/google-apps-script-task-push.gs`  
Deployed reference: `scripts/google-apps-script-task-push.deployed.gs`

1. Create a new [Google Apps Script](https://script.google.com) project.
2. Enable the **Google Tasks** advanced service under Services.
3. Paste in `scripts/google-apps-script-task-push.gs`.
4. Set these Script Properties (Project Settings → Script Properties):
   - `INGEST_URL` — your ingest worker URL
   - `INGEST_API_TOKEN` — your shared token
   - `TASKLIST_ID` — optional, defaults to `@default`
5. Add a time-based trigger for `pushTasksToReorgable` (every 15 minutes works well).

---

## Manual report utilities

Force a full report run (POST to `/run?force=true`):

```bash
npm run report:force

# Override URL or add auth
REPORT_URL=https://<your-report-worker>.workers.dev npm run report:force
REPORT_API_TOKEN=<token> npm run report:force

# Include items from the last 72 hours regardless of cursor
LOOKBACK_HOURS=72 npm run report:force

# Set an explicit item cursor
SINCE_ISO=2026-03-15T00:00:00Z npm run report:force
```

Health check:

```bash
npm run report:health
```

Local PDF preview (writes to `output/`):

```bash
npm run preview
```

---

## Schedule and timing notes

- Cron triggers fire at `12:00 UTC` and `13:00 UTC` daily. Both windows are checked; the second is a safety retry.
- The report worker enforces a Pacific-time 5:00 AM earliest-start guard in code to handle DST without updating cron strings.
- If no items were ingested since the last run, the worker skips generation unless `force=true`.

## reMarkable upload notes

The worker uses the open-source-compatible reMarkable cloud API (`/doc/v2/files`). This endpoint does not support folder placement directly, so the worker encodes folder intent in the filename:

```
Daily Briefings - YYYY-MM-DD Daily Brief.pdf
```

This makes reports easy to sort and find in the reMarkable file list.

Optional environment variables for non-standard reMarkable deployments:

| Secret | Purpose |
|---|---|
| `REMARKABLE_SESSION_TOKEN` | Override the auto-refreshed session token |
| `REMARKABLE_WEBAPP_HOST` | Override the production webapp host |
| `REMARKABLE_INTERNAL_HOST` | Override the internal cloud host |
| `REMARKABLE_IMPORT_URL` | Use an HTTP import adapter instead of the cloud API |
