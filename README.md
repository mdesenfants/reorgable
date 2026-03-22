# reorgable

A Cloudflare-based personal daily-briefing system. Throughout the day, tasks, notes, and emails are ingested and stored. Each morning, a scheduled worker summarizes everything with Gemini, renders a two-page PDF, and uploads it to your reMarkable tablet — ready to read with your coffee.

## Quickstart (recommended)

Run the guided setup script from the repo root:

```bash
bash setup.sh
```

The script walks you through prerequisites and authentication, creates or reuses Cloudflare resources, runs migrations, sets secrets, deploys workers, optionally configures Microsoft Graph sync, and runs smoke tests.

If you prefer a manual setup, continue with the "First-time setup" section below.

## How it works

```
Google Tasks ──► Google Apps Script ──┐
curl / shortcut ──────────────────────┼──► ingest-worker (D1 + R2)
Email Routing ──► email-worker ────────┤
Microsoft Graph ◄─► ms-graph-sync ─────┘
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

Four Cloudflare Workers:

| Worker | Name | Purpose |
|---|---|---|
| `workers/ingest-worker` | `reorgable-ingest` | Authenticated REST API for all ingestion |
| `workers/email-worker` | `reorgable-email` | Receives Cloudflare Email Routing events, stores EML to R2, forwards metadata to ingest |
| `workers/microsoft-graph-sync-worker` | `reorgable-ms-sync` | Syncs Microsoft To Do, flagged emails, and Outlook calendar to ingest |
| `workers/report-worker` | `reorgable-report` | Scheduled report pipeline: summarize → render → upload |

Cloudflare resources used:

| Resource | Name | Used by |
|---|---|---|
| D1 database | `daily_brief` | ingest-worker, report-worker |
| R2 bucket | `daily-brief-raw` | ingest-worker (notes/docs), email-worker (EML) |
| R2 bucket | `daily-brief-reports` | report-worker (rendered PDFs) |
| KV namespace | `STATE_KV` | report-worker (last run cursor) |
| Browser Rendering | — | report-worker (Puppeteer PDF render) |

## A day in the life

Here's how the system works end-to-end on a typical day.

### The night before (anytime)

You jot down a thought before bed:

```bash
npm run note "Ask Alex about the Q2 budget spreadsheet"
```

The `quick-note.sh` script POSTs to the ingest worker's `/ingest/note` endpoint. The note lands in D1, timestamped and ready for tomorrow's report.

### Every 15 minutes — source sync

Two automated syncs keep the ingest database fresh throughout the day:

**Google Apps Script** (runs on a timer you set, typically every 15 min):
- Pushes incomplete Google Tasks to `/ingest/task`
- Pushes today's Google Calendar events (all calendars) to `/ingest/calendar`

**Microsoft Graph sync worker** (cron at `11:00 UTC` / 4 AM Pacific):
- Pulls Microsoft To Do tasks from all lists
- Pulls flagged Outlook emails
- Pulls today's Outlook calendar events
- Forwards everything to the ingest worker

Meanwhile, emails arriving at your Cloudflare Email Routing address are caught by the email-worker, which stores the raw EML in R2 and forwards metadata to the ingest worker.

All of this accumulates in D1. Deduplication by `externalId` means repeated syncs update in place rather than creating duplicates.

### 5:00 AM Pacific — the report runs

The report-worker has cron triggers at `12:00 UTC` and `13:00 UTC` (the second is a safety retry). A Pacific-time guard in code ensures it only fires at 5 AM local, handling DST automatically.

Here's what happens:

1. **Gather items** — query D1 for everything ingested since the last run
2. **Filter for relevance** — only inbox emails linked to open tasks are included; completed tasks are excluded
3. **Build structured sections**:
  - Calendar agenda (today's events, deduplicated across calendars and sorted by start time)
   - Conflict detection (overlapping meetings are flagged)
  - To-do checklist (open tasks from Google Tasks / Microsoft To Do, with completed child tasks hidden)
   - Notes (quick captures from the note endpoint)
4. **Fetch context** — pull yesterday's overview from the last `report_runs` row
5. **Call Gemini** — send the full item list, weather forecast, yesterday's context, and any calendar conflicts to the LLM with a structured JSON schema. Gemini returns:
  - A 2–5 sentence executive overview (first sentence includes daily weather high/low and condition)
   - A delta summary (what changed since yesterday)
6. **Render the PDF** — Puppeteer prints a multi-page Letter-format document:
  - **Page 1+**: header with weather high/low, overview, delta text, day agenda, to-do checklist with checkboxes
   - **Day View page**: a visual 6 AM–9 PM calendar with event blocks and hourly weather
   - **Notes page**: any captured notes plus ruled lines for handwriting
7. **Render a reference appendix** — if there are emails or notes with longer bodies, a second PDF is generated with the full text of each item
8. **Store in R2** — both PDFs are saved to the reports bucket
9. **Upload to reMarkable** — the main brief and (if present) the reference doc are uploaded together to the `/Daily Briefings` folder on the tablet
10. **Archive yesterday's brief** — the previous day's PDF is re-uploaded to `/Briefs` for history, then marked so it won't be archived again
11. **Record the run** — D1 gets a `report_runs` row with the summary JSON, upload status, and reMarkable document ID; a `brief_engagement` row tracks the uploaded doc

### 5:01 AM — it's on your tablet

Pick up your reMarkable. The daily brief is in `/Daily Briefings`. You get:

- A quick-scan overview of the day ahead
- A visual timeline showing where your meetings fall (and if any overlap)
- A checkbox list of open tasks you can tick off with the pen
- Follow-up items that carried over from yesterday
- A notes page for meeting scribbles

The reference appendix sits alongside it if you need the full text of an email thread or a longer note.

### During the day — the feedback loop

As you work through tasks in Google Tasks or Microsoft To Do, completions flow back through the next sync cycle. The system also supports write-back to Microsoft Graph:

- `POST /tasks/create` on the MS Graph worker creates a new To Do task
- `POST /tasks/complete` marks one as done

You can check whether the brief is still on the device:

```bash
curl -X POST https://<report-worker>/check-briefs
```

This queries the reMarkable cloud for document presence. If you've deleted or archived the brief from the tablet, the system records that — a signal the brief was consumed.

### Tomorrow morning — the cycle repeats

When the next brief generates, Gemini sees yesterday's overview and compares deltas against new task/email/calendar context. The delta summary highlights what changed overnight. Yesterday's PDF moves to `/Briefs` for archival.

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
wrangler d1 execute daily_brief --remote --file migrations/0002_add_note_source.sql
wrangler d1 execute daily_brief --remote --file migrations/0003_add_calendar_source.sql
wrangler d1 execute daily_brief --remote --file migrations/0004_add_brief_engagement.sql
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

### 6. Set up Microsoft Graph sync (optional)

This worker syncs Microsoft To Do tasks, flagged Outlook emails, and calendar events into the brief. It requires an Entra ID (Azure AD) app registration with `Tasks.Read.All` and `Calendars.Read` application permissions.

Run the helper script (requires the [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)):

```bash
az login
bash scripts/setup-ms-app.sh
```

The script creates the app registration, grants permissions, and prints the four values you need. Set them as secrets along with the ingest URL and token:

```bash
printf "%s" "<app-id>"       | wrangler secret put MS_CLIENT_ID     -c workers/microsoft-graph-sync-worker/wrangler.toml
printf "%s" "<secret>"       | wrangler secret put MS_CLIENT_SECRET -c workers/microsoft-graph-sync-worker/wrangler.toml
printf "%s" "<tenant-id>"    | wrangler secret put MS_TENANT_ID     -c workers/microsoft-graph-sync-worker/wrangler.toml
printf "%s" "<user-obj-id>" | wrangler secret put MS_USER_ID       -c workers/microsoft-graph-sync-worker/wrangler.toml
printf "%s" "<ingest-url>"   | wrangler secret put INGEST_URL       -c workers/microsoft-graph-sync-worker/wrangler.toml
printf "%s" "<ingest-token>" | wrangler secret put INGEST_API_TOKEN -c workers/microsoft-graph-sync-worker/wrangler.toml
```

The worker runs on a daily cron (11:00 UTC) and also exposes `POST /tasks/create` and `POST /tasks/complete` for manual task management.

### 7. Pair reMarkable (optional)

Get a one-time code from [my.remarkable.com](https://my.remarkable.com) → Device management → Connect a device.

```bash
REMARKABLE_ONE_TIME_CODE=XXXX-XXXX npm run remarkable:pair
```

Store the returned device token:

```bash
printf "%s" "<device-token>" | wrangler secret put REMARKABLE_DEVICE_TOKEN \
  --config workers/report-worker/wrangler.toml
```

### 8. Deploy

```bash
wrangler deploy --config workers/ingest-worker/wrangler.toml
wrangler deploy --config workers/email-worker/wrangler.toml
wrangler deploy --config workers/microsoft-graph-sync-worker/wrangler.toml   # skip if you skipped step 6
npm run deploy:report
```

`deploy:report` uses `--minify` for the report worker because its bundle is large.

### 9. Configure Email Routing (optional)

In the Cloudflare dashboard, add an Email Routing rule that forwards incoming mail to your `reorgable-email` worker. Set a filter address (e.g. `brief@yourdomain.com`) that you can forward to from other services.

### 10. Smoke test

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
| `note` | Quick-capture a thought for tomorrow's brief |
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
  "details": "Ask Alex — she has the spreadsheet",
  "dueAt": "2026-03-25T00:00:00Z",
  "isDone": false,
  "relatedEmailSubject": "Re: Q2 planning",
  "relatedEmailFrom": "alice@example.com",
  "relatedEmailMessageId": "CAF123@example.com",
  "externalId": "tasks-abc123"
}
```

### `POST /ingest/email`

Ingest email metadata (used internally by the email-worker).

```json
{
  "subject": "Re: Q2 planning",
  "from": "alice@example.com",
  "to": "you@example.com",
  "bodyText": "Happy to connect Thursday",
  "isUnread": true,
  "inInbox": true,
  "isStarred": false,
  "externalId": "<message-id>"
}
```

### `POST /ingest/calendar`

Ingest a calendar event (used by Google Apps Script calendar sync):

```json
{
  "title": "Project sync",
  "startAt": "2026-03-20T17:00:00Z",
  "endAt": "2026-03-20T18:00:00Z",
  "calendarName": "Work",
  "isAllDay": false,
  "externalId": "calendar-id:event-id:start-ms"
}
```

### Email inclusion workflow

- The report worker only considers emails in the inbox (`inInbox=true`).
- Those emails are included when at least one open task (`isDone=false`) is linked to them, regardless of `isUnread` state.
- Linkage is strongest when tasks provide `relatedEmailMessageId` and/or `relatedEmailSubject` + `relatedEmailFrom`.
- If no task matches an email, that email is excluded from the brief.

### Report composition workflow

- **Agenda** is derived only from ingested `calendar` items for the target day and always shows start/end times.
- **Todos** are derived only from ingested tasks tagged `google-tasks`.
- **Page 2** renders a one-day calendar view from 6:00 AM to 9:00 PM Pacific.
- **Last page** is a dedicated full-page notes sheet.

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

Additional report-layer deduplication behavior:

- Calendar events with matching normalized title and exact start/end timestamps are collapsed so shared events from multiple calendars render once.
- Repeating task duplicates are grouped by normalized title + parent task; overdue prior instances are suppressed once a newer instance exists.
- Completed child tasks are omitted from the report checklist.

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

The script pushes:
- Open Google Tasks to `/ingest/task`
- Today's events from all calendars to `/ingest/calendar`

---

## Quick capture — dropping thoughts for tomorrow's brief

The fastest way to get a random thought into tomorrow's report:

```bash
export INGEST_API_TOKEN=<your-token>

# One-liner
npm run note "Remember to check the deploy logs"

# With a custom tag
npm run note "Ask Alex about Q2 budget" work
```

The `note` script (`scripts/quick-note.sh`) posts to `/ingest/note`. Notes appear in the **Notes** section of the next day's report and are also passed to Gemini for the overview summary.

If you prefer curl directly:

```bash
curl -X POST https://reorgable-ingest.matt-desenfants.workers.dev/ingest/note \
  -H "Authorization: Bearer $INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Quick capture","text":"Remember to check the deploy logs"}'
```

**Shell alias** (add to `~/.zshrc` or `~/.bashrc`):

```bash
note() {
  curl -s -X POST https://reorgable-ingest.matt-desenfants.workers.dev/ingest/note \
    -H "Authorization: Bearer $INGEST_API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg t "$*" '{title:"Quick capture",text:$t}')" \
  && echo "✓ Captured"
}
```

Then just: `note Remember to check the deploy logs`

---

## Manual report utilities

Force a full report run (POST to `/run?force=true`):

```bash
REPORT_URL=https://<your-report-worker>.workers.dev npm run report:force

# Add auth if your worker is protected
REPORT_API_TOKEN=<token> npm run report:force

# Include items from the last 72 hours regardless of cursor
LOOKBACK_HOURS=72 npm run report:force

# Set an explicit item cursor
SINCE_ISO=2026-03-15T00:00:00Z npm run report:force
```

Health check:

```bash
REPORT_URL=https://<your-report-worker>.workers.dev npm run report:health
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
