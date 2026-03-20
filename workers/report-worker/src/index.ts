import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { z } from "zod";
import { makeRemarkableAdapter } from "./remarkable/adapter-factory";
import { renderHtml } from "./template";

type Env = {
  DB: D1Database;
  REPORT_BUCKET: R2Bucket;
  STATE_KV: KVNamespace;
  BROWSER: BrowserWorker;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  REMARKABLE_IMPORT_URL?: string;
  REMARKABLE_DEVICE_TOKEN?: string;
  REMARKABLE_SESSION_TOKEN?: string;
  REMARKABLE_WEBAPP_HOST?: string;
  REMARKABLE_INTERNAL_HOST?: string;
};

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
  sentAt?: string;
  startAt?: string;
  endAt?: string;
  calendarName?: string;
  isAllDay?: boolean;
  relatedEmailSubject?: string;
  relatedEmailFrom?: string;
  relatedEmailMessageId?: string;
  externalId?: string;
  parentTaskId?: string;
};

type CalendarEvent = {
  title: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  endLabel: string;
  calendarName: string;
};

const llmSummarySchema = z.object({
  overview: z.string().min(1)
});

const llmSummaryJsonSchema = {
  type: "object",
  properties: {
    overview: { type: "string", description: "2-5 sentence executive summary of today." }
  },
  required: ["overview"]
} as const;

type WeatherSnapshot = {
  tempF: number;
  weatherCode: number;
  hourly: Array<{ hour: number; tempF: number; weatherCode: number }>;
};

type ArchiveResult = {
  attempted: boolean;
  archived: boolean;
  sourceKey?: string;
  message: string;
};

const PACIFIC_TIMEZONE = "America/Los_Angeles";
const CURRENT_BRIEFS_FOLDER = "/Daily Briefings";
const HISTORY_BRIEFS_FOLDER = "/Briefs";
const LAST_ARCHIVED_KEY = "last_archived_report_key";

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });

const getPacificParts = (date: Date) => {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  const value = (type: string): number => Number(formatted.find((part) => part.type === type)?.value ?? "0");

  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute")
  };
};

const shouldRunNow = (date: Date): boolean => {
  const parts = getPacificParts(date);
  return parts.hour === 5;
};

const formatDatePacific = (date: Date): string => {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    weekday: "short",
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(date);
};

const buildFileName = (date: Date): string => {
  const parts = getPacificParts(date);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd} Daily Brief.pdf`;
};

async function fetchWeather(): Promise<WeatherSnapshot> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=47.8209&longitude=-122.3151&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Los_Angeles&forecast_days=1";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status}`);
  }

  const body = (await response.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] };
  };

  const hourly: WeatherSnapshot["hourly"] = [];
  const times = body.hourly?.time ?? [];
  const temps = body.hourly?.temperature_2m ?? [];
  const codes = body.hourly?.weather_code ?? [];
  for (let i = 0; i < times.length; i++) {
    const hour = parseInt(times[i].split("T")[1].split(":")[0], 10);
    if (hour >= 6 && hour <= 21) {
      hourly.push({ hour, tempF: temps[i] ?? 0, weatherCode: codes[i] ?? -1 });
    }
  }

  return {
    tempF: body.current?.temperature_2m ?? 0,
    weatherCode: body.current?.weather_code ?? -1,
    hourly,
  };
}

async function getItemsSinceCursor(env: Env, cursor: string): Promise<IngestedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at
     FROM items
     WHERE created_at > ?1
     ORDER BY created_at ASC`
  )
    .bind(cursor)
    .all<IngestedItem>();

  return results ?? [];
}

async function getItemsSinceLastRun(
  env: Env,
  cursorOverride?: string
): Promise<{ items: IngestedItem[]; cursor: string }> {
  const fallbackCursor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cursor = cursorOverride ?? (await env.STATE_KV.get("last_report_at")) ?? fallbackCursor;

  return { items: await getItemsSinceCursor(env, cursor), cursor };
}

function safeParseMetadata(item: IngestedItem): ItemMetadata {
  try {
    const parsed = JSON.parse(item.metadata_json) as ItemMetadata;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s@.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenize(value: string): Set<string> {
  const stopwords = new Set(["the", "and", "for", "with", "from", "that", "this", "have", "will", "your", "about", "reply", "email", "thread", "follow", "message"]);
  const words = normalizeForMatch(value)
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stopwords.has(word));
  return new Set(words);
}

function overlapCount(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function emailIsLinkedToTask(task: IngestedItem, email: IngestedItem): boolean {
  const taskMeta = safeParseMetadata(task);
  const emailMeta = safeParseMetadata(email);

  const taskText = `${task.title} ${task.summary_input} ${taskMeta.relatedEmailSubject ?? ""} ${taskMeta.relatedEmailFrom ?? ""}`;
  const emailText = `${email.title} ${email.summary_input} ${emailMeta.from ?? ""} ${emailMeta.to ?? ""}`;

  const taskMessageId = (taskMeta.relatedEmailMessageId ?? "").replace(/[<>]/g, "").trim().toLowerCase();
  const emailMessageId = (emailMeta.externalId ?? "").replace(/[<>]/g, "").trim().toLowerCase();
  if (taskMessageId && emailMessageId && taskMessageId === emailMessageId) {
    return true;
  }

  const taskFrom = (taskMeta.relatedEmailFrom ?? "").trim().toLowerCase();
  const emailFrom = (emailMeta.from ?? "").trim().toLowerCase();
  const taskSubject = normalizeForMatch(taskMeta.relatedEmailSubject ?? "");
  const emailSubject = normalizeForMatch(email.title);
  if (taskFrom && emailFrom && taskFrom === emailFrom && taskSubject && emailSubject.includes(taskSubject)) {
    return true;
  }

  const taskTokens = tokenize(taskText);
  const emailTokens = tokenize(emailText);
  return overlapCount(taskTokens, emailTokens) >= 2;
}

function filterItemsForBrief(items: IngestedItem[]): IngestedItem[] {
  const tasks = items.filter((item) => item.source_type === "task");
  const nonEmails = items.filter((item) => item.source_type !== "email");
  const inboxEmails = items.filter((item) => {
    if (item.source_type !== "email") return false;
    const metadata = safeParseMetadata(item);
    return metadata.inInbox === true;
  });

  const openTasks = tasks.filter((item) => safeParseMetadata(item).isDone !== true);
  const matchedEmailIds = new Set<string>();
  for (const task of openTasks) {
    for (const email of inboxEmails) {
      if (emailIsLinkedToTask(task, email)) {
        matchedEmailIds.add(email.id);
      }
    }
  }

  const linkedEmails = inboxEmails.filter((email) => matchedEmailIds.has(email.id));
  return [...nonEmails, ...linkedEmails].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

function toPacificDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

function formatPacificTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(iso));
}

function buildCalendarAgenda(items: IngestedItem[], now: Date): CalendarEvent[] {
  const todayKey = toPacificDateKey(now.toISOString());

  const events = items
    .filter((item) => item.source_type === "calendar")
    .map((item) => {
      const m = safeParseMetadata(item);
      if (!m.startAt || !m.endAt) return null;
      return {
        title: item.title,
        startAt: m.startAt,
        endAt: m.endAt,
        calendarName: m.calendarName ?? "Calendar"
      };
    })
    .filter((v): v is { title: string; startAt: string; endAt: string; calendarName: string } => !!v)
    .filter((event) => toPacificDateKey(event.startAt) === todayKey)
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 30)
    .map((event) => ({
      ...event,
      startLabel: formatPacificTime(event.startAt),
      endLabel: formatPacificTime(event.endAt)
    }));

  return events;
}

function buildGoogleTaskTodos(items: IngestedItem[]): Array<{ task: string; done: boolean; isSubtask: boolean }> {
  const taskItems = items
    .filter((item) => item.source_type === "task")
    .map((item) => {
      const m = safeParseMetadata(item);
      return {
        task: item.title,
        done: m.isDone === true,
        isGoogleTask: (m.tags ?? []).includes("google-tasks"),
        externalId: m.externalId ?? null,
        parentTaskId: m.parentTaskId ?? null
      };
    })
    .filter((todo) => todo.isGoogleTask);

  // Group subtasks under their parents
  const parentIds = new Set(taskItems.map((t) => t.externalId).filter(Boolean));
  const result: Array<{ task: string; done: boolean; isSubtask: boolean }> = [];

  for (const todo of taskItems) {
    if (todo.parentTaskId) continue; // skip subtasks in first pass
    result.push({ task: todo.task, done: todo.done, isSubtask: false });
    // append subtasks immediately after their parent
    for (const sub of taskItems) {
      if (sub.parentTaskId === todo.externalId) {
        result.push({ task: sub.task, done: sub.done, isSubtask: true });
      }
    }
  }

  // Orphan subtasks (parent not in current batch) go at the end
  for (const todo of taskItems) {
    if (todo.parentTaskId && !parentIds.has(todo.parentTaskId)) {
      result.push({ task: todo.task, done: todo.done, isSubtask: true });
    }
  }

  return result.slice(0, 25);
}

function buildNoteLines(items: IngestedItem[]): string[] {
  return items
    .filter((item) => item.source_type === "note")
    .map((item) => item.summary_input.trim())
    .filter(Boolean)
    .slice(0, 18);
}

function buildGeminiPrompt(items: IngestedItem[], weather: WeatherSnapshot, dateLabel: string): string {
  const compact = items.map((item) => {
    const meta = safeParseMetadata(item);
    // Convert calendar timestamps to Pacific for the LLM
    if (item.source_type === "calendar" && meta.startAt && meta.endAt) {
      const startPT = formatPacificTime(meta.startAt);
      const endPT = formatPacificTime(meta.endAt);
      return {
        id: item.id,
        type: item.source_type,
        title: item.title,
        text: `${startPT} - ${endPT} (${meta.calendarName ?? "Calendar"}) ${item.title}\n${item.summary_input}`,
        metadata: { ...meta, startAtPacific: startPT, endAtPacific: endPT },
        createdAt: item.created_at
      };
    }
    return {
      id: item.id,
      type: item.source_type,
      title: item.title,
      text: item.summary_input,
      metadata: meta,
      createdAt: item.created_at
    };
  });

  return [
    "You are generating a fixed-format daily brief.",
    `Date: ${dateLabel}`,
    `Timezone: Pacific Time (America/Los_Angeles)`,
    `Weather: ${weather.tempF}F code ${weather.weatherCode}`,
    "Return JSON matching the schema exactly.",
    "Guidance:",
    "- overview: concise executive summary covering key meetings, tasks, and priorities",
    "- use the full content of emails and calendar events to understand what tasks entail",
    "- focus on key dependencies and communication risk",
    "- all times shown are already in Pacific Time",
    "Input items:",
    JSON.stringify(compact)
  ].join("\n");
}

function extractJsonObject(text: string): string {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Gemini response did not contain a JSON object");
  }
  return text.slice(firstBrace, lastBrace + 1);
}

async function summarizeWithGemini(
  env: Env,
  items: IngestedItem[],
  weather: WeatherSnapshot,
  dateLabel: string
) {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const model = env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  const prompt = buildGeminiPrompt(items, weather, dateLabel);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: llmSummaryJsonSchema
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini call failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response was empty");

  const parsed = JSON.parse(extractJsonObject(text));
  return llmSummarySchema.parse(parsed);
}

async function renderHtmlToPdf(
  env: Env,
  args: {
    dateLabel: string;
    weather: WeatherSnapshot;
    overview: string;
    agendaEvents: CalendarEvent[];
    todos: Array<{ task: string; done: boolean }>;
    noteLines: string[];
  }
): Promise<Uint8Array> {
  const html = renderHtml({
    dateLabel: args.dateLabel,
    weather: args.weather,
    overview: args.overview,
    agendaEvents: args.agendaEvents,
    todos: args.todos,
    noteLines: args.noteLines,
  });

  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBytes = await page.pdf({
      format: "Letter",
      printBackground: true,
    });
    return new Uint8Array(pdfBytes);
  } finally {
    await browser.close();
  }
}

async function persistRun(
  env: Env,
  runAt: string,
  sourceCount: number,
  summaryJson: string,
  uploadStatus: string,
  uploadMessage: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO report_runs (id, run_at, source_count, summary_json, upload_status, upload_message)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
  )
    .bind(crypto.randomUUID(), runAt, sourceCount, summaryJson, uploadStatus, uploadMessage)
    .run();
}

async function archivePreviousBrief(
  env: Env,
  adapter: ReturnType<typeof makeRemarkableAdapter>,
  now: Date,
  currentFileName: string
): Promise<ArchiveResult> {
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const previousFileName = buildFileName(yesterday);
  const previousKey = `reports/${previousFileName}`;

  if (previousFileName === currentFileName) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "Previous brief filename matched current; skipping archive"
    };
  }

  const alreadyArchived = await env.STATE_KV.get(LAST_ARCHIVED_KEY);
  if (alreadyArchived === previousKey) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "Previous brief already archived"
    };
  }

  const previousObj = await env.REPORT_BUCKET.get(previousKey);
  if (!previousObj) {
    return {
      attempted: false,
      archived: false,
      sourceKey: previousKey,
      message: "No previous brief found in R2 to archive"
    };
  }

  const bytes = new Uint8Array(await previousObj.arrayBuffer());
  const upload = await adapter.uploadPdf({
    fileName: previousFileName,
    folder: HISTORY_BRIEFS_FOLDER,
    bytes
  });

  if (!upload.ok) {
    return {
      attempted: true,
      archived: false,
      sourceKey: previousKey,
      message: `Archive upload failed: ${upload.message}`
    };
  }

  await env.STATE_KV.put(LAST_ARCHIVED_KEY, previousKey);
  return {
    attempted: true,
    archived: true,
    sourceKey: previousKey,
    message: "Archived previous brief to /Briefs"
  };
}

async function runDailyReport(env: Env, opts?: { force?: boolean; lookbackHours?: number; since?: string }) {
  const now = new Date();
  if (!opts?.force && !shouldRunNow(now)) {
    return { ok: true, skipped: true, reason: "Not 5 AM Pacific" };
  }

  let cursorOverride: string | undefined;
  if (opts?.since) {
    const parsed = new Date(opts.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("Invalid since value. Expected ISO timestamp.");
    }
    cursorOverride = parsed.toISOString();
  } else if (typeof opts?.lookbackHours === "number" && opts.lookbackHours > 0) {
    cursorOverride = new Date(now.getTime() - opts.lookbackHours * 60 * 60 * 1000).toISOString();
  }

  const dateLabel = formatDatePacific(now);
  const fileName = buildFileName(now);

  const [{ items, cursor }, weather] = await Promise.all([getItemsSinceLastRun(env, cursorOverride), fetchWeather()]);
  const filteredItems = filterItemsForBrief(items);
  const llmSummary = await summarizeWithGemini(env, filteredItems, weather, dateLabel);
  const agendaEvents = buildCalendarAgenda(filteredItems, now);
  const todos = buildGoogleTaskTodos(filteredItems);
  const noteLines = buildNoteLines(filteredItems);

  const pdfBytes = await renderHtmlToPdf(env, {
    dateLabel,
    weather,
    overview: llmSummary.overview,
    agendaEvents,
    todos,
    noteLines,
  });

  const reportKey = `reports/${fileName}`;
  await env.REPORT_BUCKET.put(reportKey, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" }
  });

  const remarkable = makeRemarkableAdapter(env);
  const uploadResult = await remarkable.uploadPdf({
    fileName,
    folder: CURRENT_BRIEFS_FOLDER,
    bytes: pdfBytes
  });

  const archiveResult = await archivePreviousBrief(env, remarkable, now, fileName);

  await persistRun(
    env,
    now.toISOString(),
    filteredItems.length,
    JSON.stringify({
      overview: llmSummary.overview,
      agendaEvents,
      todos,
      noteLines
    }),
    uploadResult.ok ? "uploaded" : "failed",
    uploadResult.message
  );

  await env.STATE_KV.put("last_report_at", now.toISOString());

  return {
    ok: true,
    skipped: false,
    cursorUsed: cursor,
    sourceCount: filteredItems.length,
    reportKey,
    remarkable: uploadResult,
    archive: archiveResult
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/health") {
      return json({ ok: true, service: "report-worker" });
    }
    if (request.method === "POST" && pathname === "/run") {
      try {
        const force = ["1", "true", "yes"].includes((url.searchParams.get("force") ?? "").toLowerCase());
        const lookbackRaw = url.searchParams.get("lookbackHours");
        const since = url.searchParams.get("since") ?? undefined;

        let lookbackHours: number | undefined;
        if (lookbackRaw) {
          const parsed = Number.parseInt(lookbackRaw, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            return json({ error: "lookbackHours must be a positive integer" }, 400);
          }
          lookbackHours = parsed;
        }

        return json(await runDailyReport(env, { force, lookbackHours, since }));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
      }
    }
    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runDailyReport(env));
  }
} satisfies ExportedHandler<Env>;
