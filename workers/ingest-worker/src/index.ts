import {
  calendarIngestSchema,
  documentIngestSchema,
  emailIngestSchema,
  noteIngestSchema,
  sourceTypeSchema,
  taskIngestSchema,
  type SourceType
} from "@reorgable/shared";

type Env = {
  DB: D1Database;
  RAW_BUCKET: R2Bucket;
  INGEST_API_TOKEN: string;
};

type IngestResult = {
  id: string;
  sourceType: SourceType;
  storedAt: string;
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" }
  });

const unauthorized = () => json({ error: "Unauthorized" }, 401);

const parseAuth = (request: Request): string | null => {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.replace("Bearer ", "").trim();
};

const sha256Hex = async (input: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
};

async function persistItem(
  env: Env,
  sourceType: SourceType,
  title: string,
  summaryInput: string,
  metadata: Record<string, unknown>,
  payload: unknown,
  idempotencySeed: string,
  refreshRelevancy = true
): Promise<IngestResult> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const idempotencyKey = await sha256Hex(`${sourceType}:${idempotencySeed}`);
  const metadataJson = JSON.stringify(metadata);

  await env.DB.prepare(
    `INSERT INTO items (id, source_type, title, summary_input, metadata_json, idempotency_key, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(idempotency_key) DO UPDATE SET
      title = excluded.title,
      summary_input = excluded.summary_input,
      metadata_json = excluded.metadata_json,
      created_at = CASE WHEN ?8 = 1 THEN excluded.created_at ELSE items.created_at END`
  )
    .bind(id, sourceType, title, summaryInput, metadataJson, idempotencyKey, now, refreshRelevancy ? 1 : 0)
    .run();

  const rawKey = `${sourceType}/${now.slice(0, 10)}/${id}.json`;
  await env.RAW_BUCKET.put(rawKey, JSON.stringify(payload, null, 2), {
    httpMetadata: { contentType: "application/json" }
  });

  return { id, sourceType, storedAt: now };
}

const parseJsonBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    throw new Error("Request body must be valid JSON");
  }
};

async function handleTaskIngest(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const payload = taskIngestSchema.parse(body);

  const result = await persistItem(
    env,
    "task",
    payload.title,
    payload.details ?? payload.title,
    {
      dueAt: payload.dueAt,
      priority: payload.priority,
      tags: payload.tags,
      isDone: payload.isDone,
      relatedEmailSubject: payload.relatedEmailSubject ?? null,
      relatedEmailFrom: payload.relatedEmailFrom ?? null,
      relatedEmailMessageId: payload.relatedEmailMessageId ?? null,
      externalId: payload.externalId ?? null,
      parentTaskId: payload.parentTaskId ?? null
    },
    payload,
    payload.externalId ?? JSON.stringify(payload),
    !payload.isDone
  );

  return json(result, 201);
}

async function handleDocumentIngest(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const payload = documentIngestSchema.parse(body);

  const result = await persistItem(
    env,
    "document",
    payload.title,
    payload.summaryHint ?? `Document ${payload.title}`,
    {
      mimeType: payload.mimeType,
      r2Key: payload.r2Key,
      externalId: payload.externalId ?? null
    },
    payload,
    payload.externalId ?? `${payload.title}:${payload.r2Key}`
  );

  return json(result, 201);
}

async function handleEmailIngest(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const payload = emailIngestSchema.parse(body);

  const result = await persistItem(
    env,
    "email",
    payload.subject,
    payload.bodyText ?? payload.subject,
    {
      from: payload.from,
      to: payload.to,
      sentAt: payload.sentAt ?? null,
      attachmentKeys: payload.attachmentKeys,
      isUnread: payload.isUnread,
      inInbox: payload.inInbox,
      isStarred: payload.isStarred,
      externalId: payload.externalId ?? null
    },
    payload,
    payload.externalId ?? `${payload.from}:${payload.subject}:${payload.sentAt ?? "n/a"}`,
    payload.isStarred
  );

  return json(result, 201);
}

async function handleNoteIngest(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const payload = noteIngestSchema.parse(body);

  const result = await persistItem(
    env,
    "note",
    payload.title,
    payload.text,
    {
      tags: payload.tags,
      externalId: payload.externalId ?? null
    },
    payload,
    payload.externalId ?? `${payload.title}:${payload.text}`
  );

  return json(result, 201);
}

async function handleCalendarIngest(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const payload = calendarIngestSchema.parse(body);

  const result = await persistItem(
    env,
    "calendar",
    payload.title,
    `${payload.startAt} - ${payload.endAt} (${payload.calendarName}) ${payload.title}`,
    {
      startAt: payload.startAt,
      endAt: payload.endAt,
      calendarName: payload.calendarName,
      isAllDay: payload.isAllDay,
      externalId: payload.externalId ?? null
    },
    payload,
    payload.externalId ?? `${payload.calendarName}:${payload.title}:${payload.startAt}:${payload.endAt}`
  );

  return json(result, 201);
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      const token = parseAuth(request);
      if (!token || token !== env.INGEST_API_TOKEN) return unauthorized();

      const { pathname } = new URL(request.url);
      if (request.method === "GET" && pathname === "/health") {
        return json({ ok: true, service: "ingest-worker" });
      }

      if (request.method === "POST" && pathname === "/ingest/task") {
        return handleTaskIngest(request, env);
      }

      if (request.method === "POST" && pathname === "/ingest/document") {
        return handleDocumentIngest(request, env);
      }

      if (request.method === "POST" && pathname === "/ingest/email") {
        return handleEmailIngest(request, env);
      }

      if (request.method === "POST" && pathname === "/ingest/note") {
        return handleNoteIngest(request, env);
      }

      if (request.method === "POST" && pathname === "/ingest/calendar") {
        return handleCalendarIngest(request, env);
      }

      return json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof Error && error.name === "ZodError") {
        return json({ error: "Validation failed", details: error.message }, 400);
      }
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 500);
    }
  }
} satisfies ExportedHandler<Env>;
