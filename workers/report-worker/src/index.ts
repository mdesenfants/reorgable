import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import type { DailyOfficeData } from "./daily-office";
import type { RemarkableUploadResult } from "./remarkable/adapter";
import { makeRemarkableAdapter } from "./remarkable/adapter-factory";
import { renderHtml } from "./template";
import { fetchDailyOffice } from "./daily-office";
import { fetchWeather, fetchTopHeadlines, getItemsSinceCursor, getOutstandingTasks, getItemsSinceLastRun } from "./fetchers";
import { filterItemsForBrief, buildGoogleTaskTodos, buildNoteLines, buildInboxSummary } from "./tasks";
import { buildCalendarAgenda, detectCalendarConflicts } from "./calendar";
import { summarizeWithGemini } from "./gemini";
import { getPreviousOverview, getPreviousEngagement, persistRun, recordEngagementTracking, checkBriefEngagement, FOLDERS } from "./persistent";

type Env = {
  DB: D1Database;
  REPORT_BUCKET: R2Bucket;
  STATE_KV: KVNamespace;
  BROWSER: BrowserWorker;
  GEMINI_API_KEY: string;
  GEMINI_MODEL?: string;
  NEWS_API?: string;
  REMARKABLE_IMPORT_URL?: string;
  REMARKABLE_DEVICE_TOKEN?: string;
  REMARKABLE_SESSION_TOKEN?: string;
  REMARKABLE_WEBAPP_HOST?: string;
  REMARKABLE_INTERNAL_HOST?: string;
  MS_GRAPH_WORKER_URL?: string;
  MS_GRAPH_WORKER_TOKEN?: string;
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });

const PACIFIC_TIMEZONE = "America/Los_Angeles";

const ENTITY_DICTIONARY_KEY = "entity_dictionary";

interface EntityEntry {
  name: string;
  type: "person" | "place" | "project" | "organization" | "other";
  definition: string;
}

async function getEntityDictionary(kv: KVNamespace): Promise<EntityEntry[]> {
  const raw = await kv.get(ENTITY_DICTIONARY_KEY);
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

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

const formatDateKeyPacific = (date: Date): string => {
  const parts = getPacificParts(date);
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${parts.year}-${mm}-${dd}`;
};

const buildFileName = (date: Date): string => {
  return `${formatDateKeyPacific(date)}.pdf`;
};

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
    weather: any;
    overview: string;
    deltaSinceYesterday: string;
    agendaEvents: any[];
    todos: Array<{ task: string; done: boolean; dueAt?: string }>;
    noteLines: string[];
    dailyOffice?: DailyOfficeData;
    inboxSummary?: string;
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
    inboxSummary: args.inboxSummary,
  });

  return htmlToPdf(env, html);
}

async function uploadWithRetry(
  adapter: any,
  args: { fileName: string; folder: string; bytes: Uint8Array },
  maxAttempts = 3
): Promise<RemarkableUploadResult> {
  let lastResult: RemarkableUploadResult = { ok: false, message: "No attempt made" };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastResult = await adapter.uploadPdf(args);
    if (lastResult.ok) return lastResult;
    if (attempt < maxAttempts - 1) {
      const delayMs = 1000 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return lastResult;
}

async function archivePreviousBrief(
  env: Env,
  adapter: any,
  now: Date,
  currentFileName: string
) {
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

  const alreadyArchived = await env.STATE_KV.get("last_archived_report_key");
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
    folder: FOLDERS.HISTORY_BRIEFS_FOLDER,
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

  await env.STATE_KV.put("last_archived_report_key", previousKey);
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

  const reportDateKey = formatDateKeyPacific(now);
  if (!opts?.force) {
    const alreadyGenerated = await env.STATE_KV.get(`report_generated:${reportDateKey}`);
    if (alreadyGenerated) {
      return { ok: true, skipped: true, reason: `Report already generated for ${reportDateKey}` };
    }
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

  const [{ items, cursor }, weather, headlines] = await Promise.all([
    getItemsSinceLastRun(env, cursorOverride),
    fetchWeather(),
    fetchTopHeadlines(env.NEWS_API),
  ]);
  const filteredItems = filterItemsForBrief(items);

  if (filteredItems.length === 0) {
    await env.STATE_KV.put("last_report_at", now.toISOString());
    return { ok: true, skipped: true, reason: "No items to include in brief", cursorUsed: cursor };
  }

  const pacificParts = getPacificParts(now);
  const pacificDate = new Date(pacificParts.year, pacificParts.month - 1, pacificParts.day);
  const [previousOverview, previousEngagement, operatorContext, dailyOffice, entityDictionary] = await Promise.all([
    getPreviousOverview(env),
    getPreviousEngagement(env),
    env.STATE_KV.get("operator_context"),
    fetchDailyOffice(env.STATE_KV, pacificDate).catch(() => undefined),
    getEntityDictionary(env.STATE_KV),
  ]);

  const agendaEvents = buildCalendarAgenda(filteredItems, now);
  const conflicts = detectCalendarConflicts(agendaEvents);
  const todos = buildGoogleTaskTodos(filteredItems);
  const noteLines = buildNoteLines(filteredItems);
  const inboxEmails = buildInboxSummary(items);

  const llmSummary = await summarizeWithGemini(
    env,
    filteredItems,
    weather,
    dateLabel,
    previousOverview,
    conflicts,
    previousEngagement,
    operatorContext ?? undefined,
    headlines,
    inboxEmails.length > 0 ? inboxEmails : undefined,
    entityDictionary.length > 0 ? entityDictionary : undefined,
  );

  const pdfBytes = await renderHtmlToPdf(env, {
    dateLabel,
    weather,
    overview: llmSummary.overview,
    deltaSinceYesterday: llmSummary.deltaSinceYesterday,
    agendaEvents,
    todos,
    noteLines,
    dailyOffice: dailyOffice ?? undefined,
    inboxSummary: llmSummary.inboxSummary,
  });

  const reportKey = `reports/${fileName}`;
  await env.REPORT_BUCKET.put(reportKey, pdfBytes, {
    httpMetadata: { contentType: "application/pdf" }
  });

  const remarkable = makeRemarkableAdapter(env);

  const uploadResult = await uploadWithRetry(remarkable, {
    fileName,
    folder: FOLDERS.CURRENT_BRIEFS_FOLDER,
    bytes: pdfBytes,
  });

  if (!uploadResult!.ok) {
    const deadLetterKey = `dead-letter/report/${fileName}`;
    await env.STATE_KV.put(deadLetterKey, pdfBytes, { expirationTtl: 7 * 24 * 60 * 60 });
  } else if (!opts?.force) {
    await env.STATE_KV.put(`report_generated:${reportDateKey}`, now.toISOString(), {
      expirationTtl: 8 * 24 * 60 * 60,
    });
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

  if (uploadResult!.ok && uploadResult!.docId) {
    await recordEngagementTracking(env, runId, uploadResult!.docId, fileName, now);
  }

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
    referenceDoc: null,
    archive: archiveResult,
  };
}

async function checkBriefEngagementStatus(env: Env) {
  const remarkable = makeRemarkableAdapter(env);
  const listResult = await remarkable.listDocuments();

  if (!listResult.ok) {
    return { ok: false, message: listResult.message, checked: 0, updated: 0 };
  }

  const remoteDocIds = new Set(listResult.documents.map((d: any) => d.id));
  const { checked, updated } = await checkBriefEngagement(env, remoteDocIds);

  return {
    ok: true,
    message: `Checked ${checked} briefs against ${listResult.documents.length} remote documents`,
    checked,
    updated,
    remoteDocCount: listResult.documents.length,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        return json(await checkBriefEngagementStatus(env));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
      }
    }
    if (pathname === "/entities") {
      if (request.method === "GET") {
        return json(await getEntityDictionary(env.STATE_KV));
      }
      if (request.method === "PUT") {
        const body = (await request.json()) as EntityEntry[] | EntityEntry;
        const entries = Array.isArray(body) ? body : [body];
        for (const entry of entries) {
          if (!entry.name || !entry.definition) {
            return json({ error: "Each entity must have name and definition" }, 400);
          }
        }
        const existing = await getEntityDictionary(env.STATE_KV);
        const merged = new Map(existing.map((e) => [e.name.toLowerCase(), e]));
        for (const entry of entries) {
          merged.set(entry.name.toLowerCase(), {
            name: entry.name,
            type: entry.type || "other",
            definition: entry.definition,
          });
        }
        const result = Array.from(merged.values());
        await env.STATE_KV.put(ENTITY_DICTIONARY_KEY, JSON.stringify(result));
        return json({ ok: true, count: result.length });
      }
      if (request.method === "DELETE") {
        const body = (await request.json()) as { name: string };
        if (!body.name) return json({ error: "name is required" }, 400);
        const existing = await getEntityDictionary(env.STATE_KV);
        const filtered = existing.filter((e) => e.name.toLowerCase() !== body.name.toLowerCase());
        await env.STATE_KV.put(ENTITY_DICTIONARY_KEY, JSON.stringify(filtered));
        return json({ ok: true, count: filtered.length });
      }
    }
    return json({ error: "Not found" }, 404);
  },

  async scheduled(_controller: any, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runDailyReport(env));
  }
} satisfies any;
