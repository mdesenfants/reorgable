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
import { buildGeminiPrompt, type CalendarConflict, type EngagementSummary, type InboxEmailSummaryItem, type EntityEntry } from "./gemini-prompt.js";
import { fetchWeather } from "./weather-helper.js";
import { fetchTopHeadlines, type NewsHeadline } from "./news-helper.js";
import { getPreviousOverview, getPreviousEngagement } from "./data-retrieval-helpers.js";
import {
  emailIsLinkedToTask,
  filterItemsForBrief,
  buildGoogleTaskTodos,
  buildNoteLines,
  safeParseMetadata,
  type IngestedItem,
  type ItemMetadata,
} from "./item-processing-helpers.js";

type PreviewKVNamespace = {
  get: (key: string) => Promise<string | null>;
  put: (key: string, value: string, options?: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  list: () => Promise<{ keys: unknown[]; list_complete: boolean }>;
  getWithMetadata: (key: string) => Promise<{ value: string | null; metadata: unknown; cacheStatus: unknown }>;
};

// ── Config ──────────────────────────────────────────────────────────

const D1_DB_NAME = "daily_brief";
const KV_NAMESPACE_ID = process.env.CLOUDFLARE_KV_NAMESPACE_ID ?? "aff13c4ce8b049fc8869a526fb392c85";
const PACIFIC_TIMEZONE = "America/Los_Angeles";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-3-flash-preview";
const NEWS_API = process.env.NEWS_API;

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

function makeNullKV(): PreviewKVNamespace {
  return {
    get: async () => null,
    put: async () => {},
    delete: async () => {},
    list: async () => ({ keys: [], list_complete: true }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  };
}

// ── Types (mirrored from worker) ────────────────────────────────────

import type { WeatherSnapshot } from "@reorgable/shared";

type CalendarEvent = {
  title: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  endLabel: string;
  calendarName: string;
  location?: string;
};

// ── Pure functions (same logic as worker) ───────────────────────────

function normalizeForMatch(v: string): string {
  return v.toLowerCase().replace(/[^a-z0-9\s@.-]+/g, " ").replace(/\s+/g, " ").trim();
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
    .map(i => { const m = safeParseMetadata(i); return m.startAt && m.endAt ? { title: i.title, startAt: m.startAt, endAt: m.endAt, calendarName: m.calendarName ?? "Calendar", location: typeof (m as Record<string, unknown>).location === "string" ? (m as Record<string, unknown>).location as string : undefined } : null; })
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

function buildInboxSummary(items: IngestedItem[]): InboxEmailSummaryItem[] {
  const tasks = items.filter(i => i.source_type === "task");
  const openTasks = tasks.filter(i => safeParseMetadata(i).isDone !== true);
  const inboxEmails = items.filter(i => {
    if (i.source_type !== "email") return false;
    return safeParseMetadata(i).inInbox === true;
  });
  return inboxEmails.map(email => {
    const meta = safeParseMetadata(email);
    const linked = openTasks.some(task => emailIsLinkedToTask(task, email));
    return {
      from: (meta.from as string) ?? "unknown",
      subject: email.title,
      preview: email.summary_input.slice(0, 300),
      sentAt: (meta.sentAt as string) ?? undefined,
      isLinkedToTask: linked,
    };
  });
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
    `SELECT id, source_type, title, summary_input, metadata_json, created_at FROM items WHERE source_type = 'task' AND COALESCE(json_extract(metadata_json, '$.isDone'), 0) != 1 AND created_at > datetime('now', '-4 hours') ORDER BY created_at ASC`,
  );

  const merged = new Map<string, IngestedItem>();
  for (const i of recent) merged.set(i.id, i);
  for (const i of outstanding) merged.set(i.id, i);

  return { items: Array.from(merged.values()).sort((a, b) => a.created_at.localeCompare(b.created_at)), cursor };
}

function extractJsonObject(text: string): string {
  const f = text.indexOf("{"), l = text.lastIndexOf("}");
  if (f === -1 || l === -1 || l <= f) throw new Error("No JSON object in Gemini response");
  return text.slice(f, l + 1);
}

async function summarizeWithGemini(
  items: IngestedItem[], weather: WeatherSnapshot, dateLabel: string,
  previousOverview?: string,
  conflicts?: CalendarConflict[], engagement?: EngagementSummary,
  operatorContext?: string,
  headlines?: NewsHeadline[],
  inboxEmails?: InboxEmailSummaryItem[],
  entityDictionary?: EntityEntry[],
) {
  if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY env var");
  const compact = items.map(item => {
    const meta = safeParseMetadata(item);
    if (item.source_type === "calendar" && meta.startAt && meta.endAt) {
      return { id: item.id, type: item.source_type, title: item.title, text: `${formatPacificTime(meta.startAt as string)} - ${formatPacificTime(meta.endAt as string)} (${(meta.calendarName as string) ?? "Calendar"}) ${item.title}\n${item.summary_input}`, metadata: { ...meta, startAtPacific: formatPacificTime(meta.startAt as string), endAtPacific: formatPacificTime(meta.endAt as string) }, createdAt: item.created_at };
    }
    return { id: item.id, type: item.source_type, title: item.title, text: item.summary_input, metadata: meta, createdAt: item.created_at };
  });
  const prompt = buildGeminiPrompt(compact, weather, dateLabel, previousOverview, conflicts, engagement, operatorContext, headlines, inboxEmails, entityDictionary);

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

// ── CLI Argument Parsing ────────────────────────────────────────────

function resolveCursorFromArgs(): string {
  if (args.since) {
    const d = new Date(args.since);
    if (Number.isNaN(d.getTime())) {
      console.error("Invalid --since value");
      process.exit(1);
    }
    return d.toISOString();
  }

  const hours = Number.parseInt(args.hours!, 10);
  if (!Number.isFinite(hours) || hours <= 0) {
    console.error("--hours must be a positive integer");
    process.exit(1);
  }
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

// ── Data Assembly ───────────────────────────────────────────────────

async function fetchAllReportData(cursorOverride: string, now: Date) {
  const { items, cursor } = getItemsSinceLastRun(cursorOverride);
  const filtered = filterItemsForBrief(items);
  console.log(`  ${items.length} raw → ${filtered.length} after filtering (cursor: ${cursor})`);

  if (filtered.length === 0) {
    console.error("No items found. Try --hours 48 or --since <date>.");
    process.exit(1);
  }

  const dateLabel = formatDatePacific(now);
  const pp = getPacificParts(now);
  const pacificDate = new Date(pp.year, pp.month - 1, pp.day);

  const [weather, dailyOffice, headlines] = await Promise.all([
    fetchWeather(),
    fetchDailyOffice(makeNullKV(), pacificDate).catch(() => undefined),
    fetchTopHeadlines(NEWS_API),
  ]);

  const previousOverview = getPreviousOverview(d1Query);
  const previousEngagement = getPreviousEngagement(d1Query);
  const operatorContext = kvGet("operator_context");
  const entityDictionaryRaw = kvGet("entity_dictionary");
  let entityDictionary: EntityEntry[] | undefined;
  if (entityDictionaryRaw) {
    try { entityDictionary = JSON.parse(entityDictionaryRaw) as EntityEntry[]; } catch { /* ignore */ }
  }

  return {
    items: filtered,
    allItems: items,
    cursor,
    dateLabel,
    now,
    weather,
    dailyOffice,
    headlines,
    previousOverview,
    previousEngagement,
    operatorContext: operatorContext ?? undefined,
    entityDictionary,
  };
}

function buildStructuredData(items: IngestedItem[], now: Date) {
  const agendaEvents = buildCalendarAgenda(items, now);
  const conflicts = detectCalendarConflicts(agendaEvents);
  const todos = buildGoogleTaskTodos(items);
  const noteLines = buildNoteLines(items);

  return { agendaEvents, conflicts, todos, noteLines };
}

async function renderAndSaveReport(
  data: TemplateData,
  skipPdf: boolean
): Promise<{ htmlPath: string; pdfPath?: string }> {
  const html = renderHtml(data);
  const outDir = join(ROOT, "output");
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "report-preview.html");
  await writeFile(htmlPath, html, "utf-8");
  console.log(`  HTML → ${htmlPath}`);

  if (skipPdf) {
    return { htmlPath };
  }

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
    return { htmlPath, pdfPath };
  } finally {
    await browser.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("📋 Live preview — pulling data via wrangler CLI\n");

  // Resolve cursor
  console.log("① Fetching items from D1...");
  const cursorOverride = resolveCursorFromArgs();

  // Fetch all data
  console.log("② Fetching weather, previous brief, daily office...");
  const now = new Date();
  const reportData = await fetchAllReportData(cursorOverride, now);

  console.log(`  Weather: H ${reportData.weather.highF.toFixed(0)}° / L ${reportData.weather.lowF.toFixed(0)}°, code ${reportData.weather.weatherCode}`);
  console.log(`  Headlines: ${reportData.headlines.length}`);
  console.log(`  Daily Office: ${reportData.dailyOffice ? `${reportData.dailyOffice.season} ${reportData.dailyOffice.week} ${reportData.dailyOffice.day}` : "unavailable"}`);

  // Build structured data
  console.log("③ Building structured data...");
  const structured = buildStructuredData(reportData.items, now);
  console.log(`  ${structured.agendaEvents.length} calendar events, ${structured.todos.length} todos, ${structured.noteLines.length} notes`);

  // Build inbox summary
  const inboxEmails = buildInboxSummary(reportData.allItems);
  if (inboxEmails.length > 0) console.log(`  ${inboxEmails.length} inbox emails`);

  // Generate summary
  console.log("④ Generating summary with Gemini...");
  const llm = await summarizeWithGemini(
    reportData.items,
    reportData.weather,
    reportData.dateLabel,
    reportData.previousOverview,
    structured.conflicts,
    reportData.previousEngagement,
    reportData.operatorContext,
    reportData.headlines,
    inboxEmails.length > 0 ? inboxEmails : undefined,
    reportData.entityDictionary,
  );

  // Render and save
  const templateData: TemplateData = {
    dateLabel: reportData.dateLabel,
    weather: reportData.weather,
    overview: llm.overview,
    deltaSinceYesterday: llm.deltaSinceYesterday,
    agendaEvents: structured.agendaEvents,
    todos: structured.todos,
    noteLines: structured.noteLines,
    dailyOffice: reportData.dailyOffice ?? undefined,
    inboxSummary: llm.inboxSummary ?? undefined,
  };

  console.log("⑤ Rendering and saving report...");
  await renderAndSaveReport(templateData, args["no-pdf"] === true);

  console.log("\n✅ Done.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
