import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { reportOutputSchema, reportOutputJsonSchema, type ReportOutput } from "@reorgable/shared";
import { makeRemarkableAdapter } from "./remarkable/adapter-factory";
import { renderHtml, renderReferenceHtml, type ReferenceItem } from "./template";
import { fetchDailyOffice, type DailyOfficeData } from "./daily-office";

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
  MS_GRAPH_WORKER_URL?: string;
  MS_GRAPH_WORKER_TOKEN?: string;
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
  dueAt?: string;
};

type CalendarEvent = {
  title: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  endLabel: string;
  calendarName: string;
};



type WeatherSnapshot = {
  highF: number;
  lowF: number;
  weatherCode: number;
  hourly: Array<{ hour: number; tempF: number; weatherCode: number }>;
};

const WEATHER_LABELS: Partial<Record<number, string>> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with hail",
  99: "Thunderstorm with heavy hail",
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

  const forecastTemps = temps.filter((temp) => typeof temp === "number");
  const highF = forecastTemps.length ? Math.max(...forecastTemps) : body.current?.temperature_2m ?? 0;
  const lowF = forecastTemps.length ? Math.min(...forecastTemps) : body.current?.temperature_2m ?? 0;

  return {
    highF,
    lowF,
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

async function getOutstandingTasks(env: Env): Promise<IngestedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at
     FROM items
     WHERE source_type = 'task'
       AND COALESCE(json_extract(metadata_json, '$.isDone'), 0) != 1
     ORDER BY created_at ASC`
  ).all<IngestedItem>();

  return results ?? [];
}

async function getItemsSinceLastRun(
  env: Env,
  cursorOverride?: string
): Promise<{ items: IngestedItem[]; cursor: string }> {
  const fallbackCursor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cursor = cursorOverride ?? (await env.STATE_KV.get("last_report_at")) ?? fallbackCursor;

  const [recentItems, outstandingTasks] = await Promise.all([
    getItemsSinceCursor(env, cursor),
    getOutstandingTasks(env)
  ]);

  const merged = new Map<string, IngestedItem>();
  for (const item of recentItems) merged.set(item.id, item);
  for (const item of outstandingTasks) merged.set(item.id, item);

  return {
    items: Array.from(merged.values()).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    cursor
  };
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

function buildReferenceItems(items: IngestedItem[]): ReferenceItem[] {
  return items
    .filter((item) => item.source_type === "email" || item.source_type === "note")
    .map((item) => {
      const m = safeParseMetadata(item);
      const meta =
        item.source_type === "email"
          ? [m.from && `From: ${m.from}`, m.sentAt && `Sent: ${m.sentAt}`].filter(Boolean).join(" · ")
          : undefined;
      return {
        source: item.source_type,
        title: item.title,
        body: item.summary_input.slice(0, 2000),
        meta: meta || undefined,
      };
    })
    .slice(0, 50);
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
    .filter((event) => toPacificDateKey(event.startAt) === todayKey);

  const dedupedEvents = new Map<string, { title: string; startAt: string; endAt: string; calendarName: string }>();
  for (const event of events) {
    const key = `${normalizeForMatch(event.title)}|${new Date(event.startAt).getTime()}|${new Date(event.endAt).getTime()}`;
    const existing = dedupedEvents.get(key);
    if (!existing) {
      dedupedEvents.set(key, event);
      continue;
    }
    if (existing.calendarName === "Calendar" && event.calendarName !== "Calendar") {
      dedupedEvents.set(key, event);
    }
  }

  return Array.from(dedupedEvents.values())
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 30)
    .map((event) => ({
      ...event,
      startLabel: formatPacificTime(event.startAt),
      endLabel: formatPacificTime(event.endAt)
    }));
}

type CalendarConflict = {
  eventA: string;
  eventB: string;
  overlapMinutes: number;
};

function detectCalendarConflicts(events: CalendarEvent[]): CalendarConflict[] {
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      const aStart = new Date(a.startAt).getTime();
      const aEnd = new Date(a.endAt).getTime();
      const bStart = new Date(b.startAt).getTime();
      const bEnd = new Date(b.endAt).getTime();

      const overlapStart = Math.max(aStart, bStart);
      const overlapEnd = Math.min(aEnd, bEnd);
      if (overlapStart < overlapEnd) {
        conflicts.push({
          eventA: a.title,
          eventB: b.title,
          overlapMinutes: Math.round((overlapEnd - overlapStart) / 60_000),
        });
      }
    }
  }
  return conflicts;
}

const TASK_SOURCE_TAGS = ["google-tasks", "microsoft-todo", "microsoft-flagged-email"];

function buildGoogleTaskTodos(items: IngestedItem[]): Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> {
  const taskItems = items
    .filter((item) => item.source_type === "task")
    .map((item) => {
      const m = safeParseMetadata(item);
      const tags = m.tags ?? [];
      return {
        task: item.title,
        done: m.isDone === true,
        isKnownTask: tags.some((t) => TASK_SOURCE_TAGS.includes(t)),
        externalId: m.externalId ?? null,
        parentTaskId: m.parentTaskId ?? null,
        dueAt: m.dueAt ?? undefined,
        normalizedTitle: normalizeForMatch(item.title),
        createdAt: item.created_at
      };
    })
    .filter((todo) => todo.isKnownTask)
    .filter((todo) => !(todo.parentTaskId && todo.done));

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const groups = new Map<string, Array<(typeof taskItems)[number]>>();
  for (const todo of taskItems) {
    if (todo.done) continue;
    const parentKey = todo.parentTaskId ?? "__root__";
    const groupKey = `${parentKey}|${todo.normalizedTitle}`;
    const group = groups.get(groupKey) ?? [];
    group.push(todo);
    groups.set(groupKey, group);
  }

  const keepOpenKeys = new Set<string>();
  for (const [groupKey, group] of groups.entries()) {
    const sorted = group
      .slice()
      .sort((left, right) => {
        const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.NEGATIVE_INFINITY;
        const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.NEGATIVE_INFINITY;
        if (leftDue !== rightDue) return leftDue - rightDue;
        return left.createdAt.localeCompare(right.createdAt);
      });

    const latest = sorted[sorted.length - 1];
    const hasCurrentOrFuture = sorted.some((entry) => {
      if (!entry.dueAt) return false;
      return new Date(entry.dueAt).getTime() >= todayStart.getTime();
    });

    if (hasCurrentOrFuture) {
      for (const entry of sorted) {
        const isOverdue = entry.dueAt ? new Date(entry.dueAt).getTime() < todayStart.getTime() : false;
        if (!isOverdue || entry === latest) {
          keepOpenKeys.add(`${groupKey}|${entry.externalId ?? entry.createdAt}`);
        }
      }
      continue;
    }

    keepOpenKeys.add(`${groupKey}|${latest.externalId ?? latest.createdAt}`);
  }

  const filteredTaskItems = taskItems.filter((todo) => {
    if (todo.done) return true;
    const parentKey = todo.parentTaskId ?? "__root__";
    const groupKey = `${parentKey}|${todo.normalizedTitle}`;
    const entryKey = `${groupKey}|${todo.externalId ?? todo.createdAt}`;
    return keepOpenKeys.has(entryKey);
  });

  // Group subtasks under their parents
  const parentIds = new Set(filteredTaskItems.map((t) => t.externalId).filter(Boolean));
  const result: Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> = [];

  for (const todo of filteredTaskItems) {
    if (todo.parentTaskId) continue; // skip subtasks in first pass
    result.push({ task: todo.task, done: todo.done, isSubtask: false, dueAt: todo.dueAt });
    // append subtasks immediately after their parent
    for (const sub of filteredTaskItems) {
      if (sub.parentTaskId === todo.externalId) {
        result.push({ task: sub.task, done: sub.done, isSubtask: true, dueAt: sub.dueAt });
      }
    }
  }

  // Orphan subtasks (parent not in current batch) go at the end
  for (const todo of filteredTaskItems) {
    if (todo.parentTaskId && !parentIds.has(todo.parentTaskId)) {
      result.push({ task: todo.task, done: todo.done, isSubtask: true, dueAt: todo.dueAt });
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

function describeWeather(weather: WeatherSnapshot): string {
  const label = WEATHER_LABELS[weather.weatherCode] ?? `WMO ${weather.weatherCode}`;
  return `high ${weather.highF.toFixed(0)}F, low ${weather.lowF.toFixed(0)}F, ${label}`;
}

function buildGeminiPrompt(items: IngestedItem[], weather: WeatherSnapshot, dateLabel: string, previousOverview?: string, conflicts?: CalendarConflict[], engagement?: EngagementSummary, operatorContext?: string): string {
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

  const lines = [
    "You are generating a fixed-format daily brief.",
    `Date: ${dateLabel}`,
    `Timezone: Pacific Time (America/Los_Angeles)`,
    `Weather: ${describeWeather(weather)} (code ${weather.weatherCode})`,
    "Return JSON matching the schema exactly.",
    "Guidance:",
    "- overview: concise executive summary covering key meetings, tasks, and priorities.",
    "- overview: the first sentence must describe today's weather using the daily high/low and condition.",
    "- deltaSinceYesterday: summarize what changed since yesterday — new items added, tasks resolved, deadlines shifted. If no previous context is provided, note that this is the first brief.",
    "- use the full content of emails and calendar events to understand what tasks entail",
    "- focus on key dependencies and communication risk",
    "- all times shown are already in Pacific Time",
  ];

  if (operatorContext) {
    lines.push("", "Operator guidance (follow these instructions from the user):", operatorContext);
  }

  if (previousOverview) {
    lines.push("", "Yesterday's brief overview (for delta comparison):", previousOverview);
  }

  if (conflicts?.length) {
    lines.push("", "⚠ Calendar conflicts detected (warn the user about these overlapping meetings):");
    for (const c of conflicts) {
      lines.push(`- "${c.eventA}" and "${c.eventB}" overlap by ${c.overlapMinutes} minutes`);
    }
  }

  if (engagement) {
    const status = engagement.stillOnDevice
      ? `still on device (last seen ${engagement.retentionHours ?? "?"}h after upload)`
      : `removed from device after ${engagement.retentionHours ?? "?"}h`;
    lines.push("", `📊 Previous brief engagement: "${engagement.briefName}" was ${status}.`);
    if (!engagement.stillOnDevice && engagement.retentionHours !== undefined && engagement.retentionHours < 1) {
      lines.push("  The user deleted the brief quickly — consider being more concise today.");
    }
  }

  lines.push("", "Input items:", JSON.stringify(compact));

  return lines.join("\n");
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
  dateLabel: string,
  previousOverview?: string,
  conflicts?: CalendarConflict[],
  engagement?: EngagementSummary,
  operatorContext?: string
): Promise<ReportOutput> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const model = env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  const prompt = buildGeminiPrompt(items, weather, dateLabel, previousOverview, conflicts, engagement, operatorContext);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: reportOutputJsonSchema
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
  return reportOutputSchema.parse(parsed);
}

async function htmlToPdf(env: Env, html: string): Promise<Uint8Array> {
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

async function renderHtmlToPdf(
  env: Env,
  args: {
    dateLabel: string;
    weather: WeatherSnapshot;
    overview: string;
    deltaSinceYesterday: string;
    agendaEvents: CalendarEvent[];
    todos: Array<{ task: string; done: boolean; dueAt?: string }>;
    noteLines: string[];
    dailyOffice?: DailyOfficeData;
  }
): Promise<Uint8Array> {
  const html = renderHtml({
    dateLabel: args.dateLabel,
    weather: args.weather,
    overview: args.overview,
    deltaSinceYesterday: args.deltaSinceYesterday,
    agendaEvents: args.agendaEvents,
    todos: args.todos,
    noteLines: args.noteLines,
    dailyOffice: args.dailyOffice,
  });

  return htmlToPdf(env, html);
}

async function persistRun(
  env: Env,
  runAt: string,
  sourceCount: number,
  summaryJson: string,
  uploadStatus: string,
  uploadMessage: string,
  remarkableDocId?: string
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO report_runs (id, run_at, source_count, summary_json, upload_status, upload_message, remarkable_doc_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
  )
    .bind(id, runAt, sourceCount, summaryJson, uploadStatus, uploadMessage, remarkableDocId ?? null)
    .run();
  return id;
}

async function getPreviousOverview(env: Env): Promise<string | undefined> {
  const row = await env.DB.prepare(
    `SELECT summary_json FROM report_runs ORDER BY run_at DESC LIMIT 1`
  ).first<{ summary_json: string }>();

  if (!row?.summary_json) return undefined;
  try {
    const parsed = JSON.parse(row.summary_json) as { overview?: string };
    return parsed.overview || undefined;
  } catch {
    return undefined;
  }
}

type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

async function getPreviousEngagement(env: Env): Promise<EngagementSummary | undefined> {
  const row = await env.DB.prepare(
    `SELECT remarkable_doc_name, uploaded_at, last_seen_at, deleted_at
     FROM brief_engagement
     ORDER BY uploaded_at DESC LIMIT 1`
  ).first<{ remarkable_doc_name: string; uploaded_at: string; last_seen_at: string | null; deleted_at: string | null }>();

  if (!row) return undefined;

  const stillOnDevice = !row.deleted_at;
  const endTime = row.deleted_at ?? row.last_seen_at ?? row.uploaded_at;
  const retentionMs = new Date(endTime).getTime() - new Date(row.uploaded_at).getTime();

  return {
    briefName: row.remarkable_doc_name,
    uploadedAt: row.uploaded_at,
    stillOnDevice,
    deletedAt: row.deleted_at ?? undefined,
    lastSeenAt: row.last_seen_at ?? undefined,
    retentionHours: retentionMs > 0 ? Math.round(retentionMs / 3_600_000 * 10) / 10 : undefined,
  };
}

async function uploadWithRetry(
  adapter: ReturnType<typeof makeRemarkableAdapter>,
  args: { fileName: string; folder: string; bytes: Uint8Array },
  maxAttempts = 3
) {
  let lastResult = { ok: false, message: "No attempt made" } as Awaited<ReturnType<typeof adapter.uploadPdf>>;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await adapter.uploadPdf(args);
    if (lastResult.ok) return lastResult;
    if (attempt < maxAttempts - 1) {
      const delayMs = 1000 * 2 ** attempt; // 1s, 2s, 4s
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastResult;
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
  const upload = await uploadWithRetry(adapter, {
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

  // Skip report if there's nothing meaningful to include
  if (filteredItems.length === 0) {
    await env.STATE_KV.put("last_report_at", now.toISOString());
    return { ok: true, skipped: true, reason: "No items to include in brief", cursorUsed: cursor };
  }

  // Fetch yesterday's overview for delta comparison
  const pacificParts = getPacificParts(now);
  const pacificDate = new Date(pacificParts.year, pacificParts.month - 1, pacificParts.day);
  const [previousOverview, previousEngagement, operatorContext, dailyOffice] = await Promise.all([
    getPreviousOverview(env),
    getPreviousEngagement(env),
    env.STATE_KV.get("operator_context"),
    fetchDailyOffice(env.STATE_KV, pacificDate).catch(() => undefined),
  ]);

  const agendaEvents = buildCalendarAgenda(filteredItems, now);
  const conflicts = detectCalendarConflicts(agendaEvents);
  const todos = buildGoogleTaskTodos(filteredItems);
  const noteLines = buildNoteLines(filteredItems);

  const llmSummary = await summarizeWithGemini(env, filteredItems, weather, dateLabel, previousOverview, conflicts, previousEngagement, operatorContext ?? undefined);

  const referenceItems = buildReferenceItems(items);
  const refFileName = fileName.replace(".pdf", "-ref.pdf");

  const [pdfBytes, refPdfBytes] = await Promise.all([
    renderHtmlToPdf(env, {
      dateLabel,
      weather,
      overview: llmSummary.overview,
      deltaSinceYesterday: llmSummary.deltaSinceYesterday,
      agendaEvents,
      todos,
      noteLines,
      dailyOffice: dailyOffice ?? undefined,
    }),
    referenceItems.length > 0
      ? htmlToPdf(env, renderReferenceHtml({ dateLabel, items: referenceItems }))
      : Promise.resolve(null),
  ]);

  const reportKey = `reports/${fileName}`;
  await env.REPORT_BUCKET.put(reportKey, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" }
  });
  if (refPdfBytes) {
    await env.REPORT_BUCKET.put(`reports/${refFileName}`, refPdfBytes, {
      httpMetadata: { contentType: "application/pdf" }
    });
  }

  const remarkable = makeRemarkableAdapter(env);

  // Upload main brief + optional reference doc with retry
  const uploadItems = [
    { fileName, folder: CURRENT_BRIEFS_FOLDER, bytes: pdfBytes },
    ...(refPdfBytes ? [{ fileName: refFileName, folder: CURRENT_BRIEFS_FOLDER, bytes: refPdfBytes }] : []),
  ];

  let multiResult: Awaited<ReturnType<typeof remarkable.uploadMultiplePdfs>>;
  let uploadResult: (typeof multiResult)["results"][0];
  const maxMultiAttempts = 3;

  for (let attempt = 0; attempt < maxMultiAttempts; attempt++) {
    multiResult = await remarkable.uploadMultiplePdfs(uploadItems);
    uploadResult = multiResult.results[0];
    if (uploadResult.ok) break;
    if (attempt < maxMultiAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }

  // Dead-letter to KV if all retries failed — allows manual recovery
  if (!uploadResult!.ok) {
    const deadLetterKey = `dead-letter/report/${fileName}`;
    await env.STATE_KV.put(deadLetterKey, pdfBytes, { expirationTtl: 7 * 24 * 60 * 60 });
    if (refPdfBytes) {
      await env.STATE_KV.put(`dead-letter/report/${refFileName}`, refPdfBytes, { expirationTtl: 7 * 24 * 60 * 60 });
    }
  }

  const archiveResult = await archivePreviousBrief(env, remarkable, now, fileName);

  const runId = await persistRun(
    env,
    now.toISOString(),
    filteredItems.length,
    JSON.stringify({
      overview: llmSummary.overview,
      deltaSinceYesterday: llmSummary.deltaSinceYesterday,
      agendaEvents,
      todos,
      noteLines
    }),
    uploadResult!.ok ? "uploaded" : "failed",
    uploadResult!.message,
    uploadResult!.docId
  );

  // Record engagement tracking entry for uploaded briefs
  if (uploadResult!.ok && uploadResult!.docId) {
    await env.DB.prepare(
      `INSERT INTO brief_engagement (id, report_run_id, remarkable_doc_id, remarkable_doc_name, uploaded_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`
    )
      .bind(crypto.randomUUID(), runId, uploadResult!.docId, fileName, now.toISOString())
      .run();
  }

  // Only advance the cursor on scheduled runs — force runs shouldn't consume items
  if (!opts?.force) {
    await env.STATE_KV.put("last_report_at", now.toISOString());
  }

  return {
    ok: true,
    skipped: false,
    cursorUsed: cursor,
    sourceCount: filteredItems.length,
    reportKey,
    remarkable: uploadResult!,
    referenceDoc: multiResult!.results[1] ?? null,
    archive: archiveResult,
  };
}

async function checkBriefEngagement(env: Env) {
  const remarkable = makeRemarkableAdapter(env);
  const listResult = await remarkable.listDocuments();

  if (!listResult.ok) {
    return { ok: false, message: listResult.message, checked: 0, updated: 0 };
  }

  const remoteDocIds = new Set(listResult.documents.map((d) => d.id));

  // Get all tracked briefs that haven't been marked deleted
  const { results: tracked } = await env.DB.prepare(
    `SELECT id, remarkable_doc_id FROM brief_engagement WHERE deleted_at IS NULL AND remarkable_doc_id IS NOT NULL`
  ).all<{ id: string; remarkable_doc_id: string }>();

  let updated = 0;
  const now = new Date().toISOString();

  for (const entry of tracked ?? []) {
    if (remoteDocIds.has(entry.remarkable_doc_id)) {
      // Still on device — update last_seen_at
      await env.DB.prepare(
        `UPDATE brief_engagement SET last_seen_at = ?1 WHERE id = ?2`
      ).bind(now, entry.id).run();
      updated++;
    } else {
      // No longer on device — mark as deleted (user removed or archived)
      await env.DB.prepare(
        `UPDATE brief_engagement SET deleted_at = ?1 WHERE id = ?2`
      ).bind(now, entry.id).run();
      updated++;
    }
  }

  return {
    ok: true,
    message: `Checked ${tracked?.length ?? 0} briefs against ${listResult.documents.length} remote documents`,
    checked: tracked?.length ?? 0,
    updated,
    remoteDocCount: listResult.documents.length,
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    if (request.method === "GET" && pathname === "/health") {
      const lastRun = await env.DB.prepare(
        `SELECT run_at, source_count, upload_status, upload_message FROM report_runs ORDER BY run_at DESC LIMIT 1`
      ).first<{ run_at: string; source_count: number; upload_status: string; upload_message: string }>();

      const lastReportAt = await env.STATE_KV.get("last_report_at");
      const hoursAgo = lastReportAt
        ? ((Date.now() - new Date(lastReportAt).getTime()) / 3_600_000).toFixed(1)
        : null;

      return json({
        ok: true,
        service: "report-worker",
        lastRun: lastRun
          ? {
              runAt: lastRun.run_at,
              sourceCount: lastRun.source_count,
              uploadStatus: lastRun.upload_status,
              uploadMessage: lastRun.upload_message,
              hoursAgo,
            }
          : null,
      });
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
    if (request.method === "POST" && pathname === "/check-briefs") {
      try {
        return json(await checkBriefEngagement(env));
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
