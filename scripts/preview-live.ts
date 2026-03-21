/**
 * Local live-data preview.
 *
 * Pulls real data from Cloudflare D1 and KV via `wrangler` CLI (uses your
 * existing wrangler login — no tokens or public endpoints required), calls
 * Gemini and Open-Meteo directly, renders the HTML template, and optionally
 * prints a PDF via local Puppeteer.
 *
 * Usage:
 *   npm run preview:live                        # default 24h lookback
 *   npm run preview:live -- --hours 48           # custom lookback
 *   npm run preview:live -- --since 2026-03-20   # explicit cutoff
 *   npm run preview:live -- --no-pdf             # skip PDF, HTML only
 *
 * Output:
 *   output/report-preview.html
 *   output/report-preview.pdf   (unless --no-pdf)
 *
 * Environment:
 *   GEMINI_API_KEY  – required
 *   GEMINI_MODEL    – optional (default: gemini-3-flash-preview)
 */

import { execSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderHtml, type TemplateData } from "../workers/report-worker/src/template.js";
import { fetchDailyOffice, type DailyOfficeData } from "../workers/report-worker/src/daily-office.js";
import { reportOutputSchema, reportOutputJsonSchema } from "../packages/shared/src/report-schema.js";

// ── Config ──────────────────────────────────────────────────────────

const D1_DB_NAME = "daily_brief";
const KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? "aff13c4ce8b049fc8869a526fb392c85";
const PACIFIC_TIMEZONE = "America/Los_Angeles";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

// ── CLI args ────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    hours: { type: "string", default: "24" },
    since: { type: "string" },
    "no-pdf": { type: "boolean", default: false },
  },
  allowPositionals: true,
});

// ── Wrangler CLI helpers ────────────────────────────────────────────

function d1Query<T>(sql: string): T[] {
  const escaped = sql.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute "${D1_DB_NAME}" --remote --json --command="${escaped}"`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function kvGet(key: string): string | null {
  try {
    const result = execSync(
      `npx wrangler kv key get "${key}" --namespace-id="${KV_NAMESPACE_ID}" --remote --text`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

// ── Fake KVNamespace for daily-office (no caching, just pass-through) ──

function makeNullKV(): KVNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

// ── Types (mirrored from worker) ────────────────────────────────────

type IngestedItem = {
  id: string;
  source_type: "task" | "document" | "email" | "note" | "calendar";
  title: string;
  summary_input: string;
  metadata_json: string;
  created_at: string;
};

type ItemMetadata = {
  isDone?: boolean;
  isUnread?: boolean;
  inInbox?: boolean;
  tags?: string[];
  from?: string;
  to?: string;
  startAt?: string;
  endAt?: string;
  calendarName?: string;
  externalId?: string;
  parentTaskId?: string;
  dueAt?: string;
};

type WeatherSnapshot = {
  tempF: number;
  weatherCode: number;
  hourly: Array<{ hour: number; tempF: number; weatherCode: number }>;
};

type CalendarEvent = {
  title: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  endLabel: string;
  calendarName: string;
};

type CalendarConflict = { eventA: string; eventB: string; overlapMinutes: number };

type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

// ── Pure functions (same logic as worker) ───────────────────────────

function safeParseMetadata(item: IngestedItem): ItemMetadata {
  try {
    const p = JSON.parse(item.metadata_json) as ItemMetadata;
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

function normalizeForMatch(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9\s@.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(v: string): Set<string> {
  const stop = new Set(["the","and","for","with","from","that","this","have","will","your","about","reply","email","thread","follow","message"]);
  return new Set(normalizeForMatch(v).split(" ").filter(w => w.length >= 4 && !stop.has(w)));
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

function emailIsLinkedToTask(task: IngestedItem, email: IngestedItem): boolean {
  const tm = safeParseMetadata(task);
  const em = safeParseMetadata(email);
  if (tm.relatedEmailMessageId && em.externalId && normalizeForMatch(tm.relatedEmailMessageId) === normalizeForMatch(em.externalId)) return true;
  const titleTokens = tokenize(task.title);
  const emailTokens = tokenize(email.title);
  if (titleTokens.size >= 2 && emailTokens.size >= 2 && overlapCount(titleTokens, emailTokens) >= 2) return true;
  if (tm.relatedEmailFrom && em.from && normalizeForMatch(tm.relatedEmailFrom) === normalizeForMatch(em.from)) {
    if (tm.relatedEmailSubject && overlapCount(tokenize(tm.relatedEmailSubject), emailTokens) >= 2) return true;
  }
  return false;
}

function filterItemsForBrief(items: IngestedItem[]): IngestedItem[] {
  const tasks = items.filter(i => i.source_type === "task");
  const nonEmails = items.filter(i => i.source_type !== "email");
  const inboxEmails = items.filter(i => {
    if (i.source_type !== "email") return false;
    return safeParseMetadata(i).inInbox === true;
  });
  const openTasks = tasks.filter(i => safeParseMetadata(i).isDone !== true);
  const matchedIds = new Set<string>();
  for (const task of openTasks) for (const email of inboxEmails) if (emailIsLinkedToTask(task, email)) matchedIds.add(email.id);
  const linked = inboxEmails.filter(e => matchedIds.has(e.id));
  return [...nonEmails, ...linked].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function toPacificDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(iso));
  return `${parts.find(p => p.type === "year")?.value}-${parts.find(p => p.type === "month")?.value}-${parts.find(p => p.type === "day")?.value}`;
}

function formatPacificTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIMEZONE, hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

const formatDatePacific = (d: Date): string =>
  new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIMEZONE, weekday: "short", year: "numeric", month: "long", day: "numeric" }).format(d);

const getPacificParts = (date: Date) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const v = (t: string) => Number(f.find(p => p.type === t)?.value ?? "0");
  return { year: v("year"), month: v("month"), day: v("day"), hour: v("hour"), minute: v("minute") };
};

function buildCalendarAgenda(items: IngestedItem[], now: Date): CalendarEvent[] {
  const todayKey = toPacificDateKey(now.toISOString());
  return items
    .filter(i => i.source_type === "calendar")
    .map(i => { const m = safeParseMetadata(i); return m.startAt && m.endAt ? { title: i.title, startAt: m.startAt, endAt: m.endAt, calendarName: m.calendarName ?? "Calendar" } : null; })
    .filter((v): v is NonNullable<typeof v> => !!v)
    .filter(e => toPacificDateKey(e.startAt) === todayKey)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 30)
    .map(e => ({ ...e, startLabel: formatPacificTime(e.startAt), endLabel: formatPacificTime(e.endAt) }));
}

function detectCalendarConflicts(events: CalendarEvent[]): CalendarConflict[] {
  const out: CalendarConflict[] = [];
  for (let i = 0; i < events.length; i++) for (let j = i + 1; j < events.length; j++) {
    const aS = new Date(events[i].startAt).getTime(), aE = new Date(events[i].endAt).getTime();
    const bS = new Date(events[j].startAt).getTime(), bE = new Date(events[j].endAt).getTime();
    const os = Math.max(aS, bS), oe = Math.min(aE, bE);
    if (os < oe) out.push({ eventA: events[i].title, eventB: events[j].title, overlapMinutes: Math.round((oe - os) / 60_000) });
  }
  return out;
}

const TASK_SOURCE_TAGS = ["google-tasks", "microsoft-todo", "microsoft-flagged-email"];

function buildGoogleTaskTodos(items: IngestedItem[]) {
  const taskItems = items.filter(i => i.source_type === "task").map(i => {
    const m = safeParseMetadata(i);
    return { task: i.title, done: m.isDone === true, isKnownTask: (m.tags ?? []).some(t => TASK_SOURCE_TAGS.includes(t)), externalId: m.externalId ?? null, parentTaskId: m.parentTaskId ?? null, dueAt: m.dueAt };
  }).filter(t => t.isKnownTask);
  const parentIds = new Set(taskItems.map(t => t.externalId).filter(Boolean));
  const result: Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> = [];
  for (const t of taskItems) {
    if (t.parentTaskId) continue;
    result.push({ task: t.task, done: t.done, isSubtask: false, dueAt: t.dueAt });
    for (const s of taskItems) if (s.parentTaskId === t.externalId) result.push({ task: s.task, done: s.done, isSubtask: true, dueAt: s.dueAt });
  }
  for (const t of taskItems) if (t.parentTaskId && !parentIds.has(t.parentTaskId)) result.push({ task: t.task, done: t.done, isSubtask: true, dueAt: t.dueAt });
  return result.slice(0, 25);
}

function buildNoteLines(items: IngestedItem[]): string[] {
  return items.filter(i => i.source_type === "note").map(i => i.summary_input.trim()).filter(Boolean).slice(0, 18);
}

// ── Data fetchers ───────────────────────────────────────────────────

function getItemsSinceLastRun(cursorOverride?: string): { items: IngestedItem[]; cursor: string } {
  const fallback = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cursor = cursorOverride ?? kvGet("last_report_at") ?? fallback;

  console.log(`  D1 query: items since ${cursor}`);
  const recent = d1Query<IngestedItem>(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at FROM items WHERE created_at > '${cursor}' ORDER BY created_at ASC`,
  );
  const outstanding = d1Query<IngestedItem>(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at FROM items WHERE source_type = 'task' AND COALESCE(json_extract(metadata_json, '$.isDone'), 0) != 1 ORDER BY created_at ASC`,
  );

  const merged = new Map<string, IngestedItem>();
  for (const i of recent) merged.set(i.id, i);
  for (const i of outstanding) merged.set(i.id, i);

  return { items: Array.from(merged.values()).sort((a, b) => a.created_at.localeCompare(b.created_at)), cursor };
}

async function fetchWeather(): Promise<WeatherSnapshot> {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=47.8209&longitude=-122.3151&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Los_Angeles&forecast_days=1";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const body = await res.json() as { current?: { temperature_2m?: number; weather_code?: number }; hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] } };
  const hourly: WeatherSnapshot["hourly"] = [];
  const times = body.hourly?.time ?? [], temps = body.hourly?.temperature_2m ?? [], codes = body.hourly?.weather_code ?? [];
  for (let i = 0; i < times.length; i++) { const h = parseInt(times[i].split("T")[1].split(":")[0], 10); if (h >= 6 && h <= 21) hourly.push({ hour: h, tempF: temps[i] ?? 0, weatherCode: codes[i] ?? -1 }); }
  return { tempF: body.current?.temperature_2m ?? 0, weatherCode: body.current?.weather_code ?? -1, hourly };
}

function getPreviousOverview(): string | undefined {
  const rows = d1Query<{ summary_json: string }>("SELECT summary_json FROM report_runs ORDER BY run_at DESC LIMIT 1");
  if (!rows[0]?.summary_json) return undefined;
  try { return (JSON.parse(rows[0].summary_json) as { overview?: string }).overview || undefined; } catch { return undefined; }
}

function getPreviousFollowUps(): string[] | undefined {
  const rows = d1Query<{ summary_json: string }>("SELECT summary_json FROM report_runs ORDER BY run_at DESC LIMIT 1");
  if (!rows[0]?.summary_json) return undefined;
  try { const p = JSON.parse(rows[0].summary_json) as { followUps?: string[] }; return p.followUps?.length ? p.followUps : undefined; } catch { return undefined; }
}

function getPreviousEngagement(): EngagementSummary | undefined {
  const rows = d1Query<{ remarkable_doc_name: string; uploaded_at: string; last_seen_at: string | null; deleted_at: string | null }>(
    "SELECT remarkable_doc_name, uploaded_at, last_seen_at, deleted_at FROM brief_engagement ORDER BY uploaded_at DESC LIMIT 1",
  );
  const row = rows[0];
  if (!row) return undefined;
  const stillOnDevice = !row.deleted_at;
  const endTime = row.deleted_at ?? row.last_seen_at ?? row.uploaded_at;
  const retentionMs = new Date(endTime).getTime() - new Date(row.uploaded_at).getTime();
  return {
    briefName: row.remarkable_doc_name, uploadedAt: row.uploaded_at, stillOnDevice,
    deletedAt: row.deleted_at ?? undefined, lastSeenAt: row.last_seen_at ?? undefined,
    retentionHours: retentionMs > 0 ? Math.round(retentionMs / 3_600_000 * 10) / 10 : undefined,
  };
}

// ── Gemini ──────────────────────────────────────────────────────────

function buildGeminiPrompt(
  items: IngestedItem[], weather: WeatherSnapshot, dateLabel: string,
  previousOverview?: string, previousFollowUps?: string[],
  conflicts?: CalendarConflict[], engagement?: EngagementSummary,
  operatorContext?: string,
): string {
  const compact = items.map(item => {
    const meta = safeParseMetadata(item);
    if (item.source_type === "calendar" && meta.startAt && meta.endAt) {
      return { id: item.id, type: item.source_type, title: item.title, text: `${formatPacificTime(meta.startAt)} - ${formatPacificTime(meta.endAt)} (${meta.calendarName ?? "Calendar"}) ${item.title}\n${item.summary_input}`, metadata: { ...meta, startAtPacific: formatPacificTime(meta.startAt), endAtPacific: formatPacificTime(meta.endAt) }, createdAt: item.created_at };
    }
    return { id: item.id, type: item.source_type, title: item.title, text: item.summary_input, metadata: meta, createdAt: item.created_at };
  });

  const lines = [
    "You are generating a fixed-format daily brief.",
    `Date: ${dateLabel}`, `Timezone: Pacific Time (America/Los_Angeles)`,
    `Weather: ${weather.tempF}F code ${weather.weatherCode}`,
    "Return JSON matching the schema exactly.",
    "Guidance:",
    "- overview: concise executive summary covering key meetings, tasks, and priorities",
    "- deltaSinceYesterday: summarize what changed since yesterday",
    "- followUps: list specific calls, emails, messages, or actions to take today",
    "- use the full content of emails and calendar events",
    "- focus on key dependencies and communication risk",
    "- all times shown are already in Pacific Time",
  ];
  if (operatorContext) lines.push("", "Operator guidance:", operatorContext);
  if (previousOverview) lines.push("", "Yesterday's overview:", previousOverview);
  if (previousFollowUps?.length) { lines.push("", "Yesterday's follow-ups:"); for (const f of previousFollowUps) lines.push(`- ${f}`); }
  if (conflicts?.length) { lines.push("", "⚠ Calendar conflicts:"); for (const c of conflicts) lines.push(`- "${c.eventA}" and "${c.eventB}" overlap by ${c.overlapMinutes}min`); }
  if (engagement) {
    const s = engagement.stillOnDevice ? `still on device (${engagement.retentionHours ?? "?"}h)` : `removed after ${engagement.retentionHours ?? "?"}h`;
    lines.push("", `📊 Previous brief: "${engagement.briefName}" ${s}.`);
    if (!engagement.stillOnDevice && engagement.retentionHours !== undefined && engagement.retentionHours < 1) lines.push("  Deleted quickly — be more concise.");
  }
  lines.push("", "Input items:", JSON.stringify(compact));
  return lines.join("\n");
}

function extractJsonObject(text: string): string {
  const f = text.indexOf("{"), l = text.lastIndexOf("}");
  if (f === -1 || l === -1 || l <= f) throw new Error("No JSON object in Gemini response");
  return text.slice(f, l + 1);
}

async function summarizeWithGemini(
  items: IngestedItem[], weather: WeatherSnapshot, dateLabel: string,
  previousOverview?: string, previousFollowUps?: string[],
  conflicts?: CalendarConflict[], engagement?: EngagementSummary,
  operatorContext?: string,
) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY env var");
  const prompt = buildGeminiPrompt(items, weather, dateLabel, previousOverview, previousFollowUps, conflicts, engagement, operatorContext);

  console.log("  Calling Gemini...");
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: reportOutputJsonSchema },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini failed: ${res.status} ${await res.text()}`);
  const body = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response empty");
  return reportOutputSchema.parse(JSON.parse(extractJsonObject(text)));
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("📋 Live preview — pulling data via wrangler CLI\n");

  // Resolve cursor
  let cursorOverride: string | undefined;
  if (args.since) {
    const d = new Date(args.since);
    if (Number.isNaN(d.getTime())) { console.error("Invalid --since value"); process.exit(1); }
    cursorOverride = d.toISOString();
  } else {
    const hours = Number.parseInt(args.hours!, 10);
    if (!Number.isFinite(hours) || hours <= 0) { console.error("--hours must be a positive integer"); process.exit(1); }
    cursorOverride = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  }

  // 1. Fetch items from D1
  console.log("① Fetching items from D1...");
  const { items, cursor } = getItemsSinceLastRun(cursorOverride);
  const filtered = filterItemsForBrief(items);
  console.log(`  ${items.length} raw → ${filtered.length} after filtering (cursor: ${cursor})`);
  if (filtered.length === 0) { console.error("No items found. Try --hours 48 or --since <date>."); process.exit(1); }

  // 2. Parallel fetches: weather, previous data, daily office
  console.log("② Fetching weather, previous brief, daily office...");
  const now = new Date();
  const dateLabel = formatDatePacific(now);
  const pp = getPacificParts(now);
  const pacificDate = new Date(pp.year, pp.month - 1, pp.day);

  const [weather, dailyOffice] = await Promise.all([
    fetchWeather(),
    fetchDailyOffice(makeNullKV(), pacificDate).catch(() => undefined),
  ]);
  const previousOverview = getPreviousOverview();
  const previousFollowUps = getPreviousFollowUps();
  const previousEngagement = getPreviousEngagement();
  const operatorContext = kvGet("operator_context");

  console.log(`  Weather: ${weather.tempF}°F, code ${weather.weatherCode}`);
  console.log(`  Daily Office: ${dailyOffice ? `${dailyOffice.season} ${dailyOffice.week} ${dailyOffice.day}` : "unavailable"}`);

  // 3. Build structured data
  const agendaEvents = buildCalendarAgenda(filtered, now);
  const conflicts = detectCalendarConflicts(agendaEvents);
  const todos = buildGoogleTaskTodos(filtered);
  const noteLines = buildNoteLines(filtered);
  console.log(`  ${agendaEvents.length} calendar events, ${todos.length} todos, ${noteLines.length} notes`);

  // 4. Gemini summary
  console.log("③ Generating summary with Gemini...");
  const llm = await summarizeWithGemini(
    filtered, weather, dateLabel,
    previousOverview, previousFollowUps, conflicts,
    previousEngagement, operatorContext ?? undefined,
  );

  // 5. Render HTML
  console.log("④ Rendering HTML...");
  const data: TemplateData = {
    dateLabel, weather,
    overview: llm.overview,
    deltaSinceYesterday: llm.deltaSinceYesterday,
    followUps: llm.followUps,
    agendaEvents, todos, noteLines,
    dailyOffice: dailyOffice ?? undefined,
  };
  const html = renderHtml(data);

  const outDir = join(ROOT, "output");
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "report-preview.html");
  await writeFile(htmlPath, html, "utf-8");
  console.log(`  HTML → ${htmlPath}`);

  // 6. Optional PDF
  if (!args["no-pdf"]) {
    console.log("⑤ Printing PDF...");
    const puppeteer = await import("puppeteer");
    const browser = await puppeteer.default.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdfBytes = await page.pdf({ format: "Letter", printBackground: true });
      const pdfPath = join(outDir, "report-preview.pdf");
      await writeFile(pdfPath, pdfBytes);
      console.log(`  PDF  → ${pdfPath}`);
    } finally {
      await browser.close();
    }
  }

  console.log("\n✅ Done.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
