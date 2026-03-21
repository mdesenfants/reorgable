/**
 * Microsoft Graph Sync Worker
 *
 * Runs daily at 11:00 UTC (1 hour before the report worker).
 * Pulls Microsoft To Do tasks (all lists + flagged emails) and today's
 * Outlook calendar events, then POSTs them to the reorgable ingest worker.
 *
 * Required secrets (set via `wrangler secret put`):
 *   MS_CLIENT_ID      – Entra ID app client ID
 *   MS_CLIENT_SECRET  – Entra ID app client secret
 *   MS_TENANT_ID      – Entra ID tenant ID
 *   MS_USER_ID        – Object ID (or UPN) of the user to sync
 *   INGEST_URL        – Base URL of the ingest worker (no trailing slash)
 *   INGEST_API_TOKEN  – Bearer token for the ingest worker
 */

export interface Env {
  MS_CLIENT_ID: string;
  MS_CLIENT_SECRET: string;
  MS_TENANT_ID: string;
  MS_USER_ID: string;
  INGEST_URL: string;
  INGEST_API_TOKEN: string;
  INGEST_SERVICE?: Fetcher;
}

// ---------------------------------------------------------------------------
// Microsoft Graph auth
// ---------------------------------------------------------------------------

async function getAccessToken(env: Env): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: env.MS_CLIENT_ID,
    client_secret: env.MS_CLIENT_SECRET,
    scope: "https://graph.microsoft.com/.default",
  });

  const res = await fetch(
    `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token request failed ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

async function graphGet<T>(
  token: string,
  path: string,
  params?: Record<string, string>
): Promise<T> {
  let url = `https://graph.microsoft.com/v1.0${path}`;
  if (params) {
    // Graph To Do endpoints can reject encoded OData keys (for example %24filter),
    // so preserve keys like $filter/$select and encode values only.
    const query = Object.entries(params)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    if (query) {
      url += `?${query}`;
    }
  }

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph request failed ${res.status}: ${text}`);
  }

  return res.json() as Promise<T>;
}

/** Follow @odata.nextLink until all pages are collected. */
async function graphGetAll<T>(
  token: string,
  path: string,
  params?: Record<string, string>
): Promise<T[]> {
  const results: T[] = [];
  let nextLink: string | undefined;

  const first = await graphGet<{ value: T[]; "@odata.nextLink"?: string }>(
    token,
    path,
    params
  );
  results.push(...first.value);
  nextLink = first["@odata.nextLink"];

  while (nextLink) {
    const res = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) break;
    const page = (await res.json()) as {
      value: T[];
      "@odata.nextLink"?: string;
    };
    results.push(...page.value);
    nextLink = page["@odata.nextLink"];
  }

  return results;
}

// ---------------------------------------------------------------------------
// To Do task sync
// ---------------------------------------------------------------------------

type TodoList = {
  id: string;
  displayName: string;
  wellknownListName: string;
};

type TodoTask = {
  id: string;
  title: string;
  status?: string; // "notStarted" | "inProgress" | "waitingOnOthers" | "deferred" | "completed"
  importance?: "low" | "normal" | "high";
  body?: { content?: string; contentType?: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  parentList?: { id: string };
};

type IngestTaskPayload = {
  title: string;
  details?: string;
  dueAt?: string;
  priority: "low" | "medium" | "high";
  tags: string[];
  isDone: boolean;
  externalId: string;
};

function mapImportance(importance: TodoTask["importance"]): "low" | "medium" | "high" {
  if (!importance) return "medium";
  if (importance === "high") return "high";
  if (importance === "low") return "low";
  return "medium";
}

function toUtcIso(dateTime: string, _timeZone: string): string {
  // Graph returns dateTime in UTC when timeZone is "UTC", or local time otherwise.
  // For simplicity we treat the value as UTC — most Graph clients store due dates
  // as date-only values (e.g. "2026-03-20T00:00:00.0000000") scoped to UTC.
  if (dateTime.endsWith("Z") || dateTime.includes("+")) return dateTime;
  return dateTime + "Z";
}

async function syncTodoTasks(
  token: string,
  env: Env
): Promise<{ pushed: number; failed: number }> {
  const lists = await graphGetAll<TodoList>(
    token,
    `/users/${env.MS_USER_ID}/todo/lists`
  );

  let pushed = 0;
  let failed = 0;

  for (const list of lists) {
    const isFlaggedEmail = list.wellknownListName === "flaggedEmails";
    const tag = isFlaggedEmail ? "microsoft-flagged-email" : "microsoft-todo";

    // Some tenants reject $filter/$select for this endpoint with ParseUri errors,
    // so fetch the list tasks directly and filter completed tasks locally.
    const tasks = await graphGetAll<TodoTask>(
      token,
      `/users/${env.MS_USER_ID}/todo/lists/${encodeURIComponent(list.id)}/tasks`
    );

    for (const task of tasks) {
      if (task.status === "completed") continue;

      const payload: IngestTaskPayload = {
        title: task.title || "Untitled task",
        details:
          task.body?.content && task.body.contentType === "text"
            ? task.body.content.trim() || undefined
            : undefined,
        dueAt: task.dueDateTime
          ? toUtcIso(task.dueDateTime.dateTime, task.dueDateTime.timeZone)
          : undefined,
        priority: mapImportance(task.importance),
        tags: [tag],
        isDone: false,
        externalId: task.id,
      };

      const ok = await postToIngest(env, "/ingest/task", payload);
      if (ok) pushed++;
      else failed++;
    }
  }

  return { pushed, failed };
}

// ---------------------------------------------------------------------------
// Calendar sync
// ---------------------------------------------------------------------------

type CalendarEvent = {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  calendar?: { name: string };
};

type IngestCalendarPayload = {
  title: string;
  startAt: string;
  endAt: string;
  calendarName: string;
  isAllDay: boolean;
  externalId: string;
};

async function syncCalendarEvents(
  token: string,
  env: Env
): Promise<{ pushed: number; failed: number }> {
  // Build today's date range in UTC (00:00 – 23:59:59)
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  ).toISOString();
  const todayEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)
  ).toISOString();

  // calendarView returns expanded recurring events; expand the calendar name via $expand
  const events = await graphGetAll<CalendarEvent>(
    token,
    `/users/${env.MS_USER_ID}/calendarView`,
    {
      startDateTime: todayStart,
      endDateTime: todayEnd,
      $select: "id,subject,start,end,isAllDay",
      $expand: "calendar($select=name)",
      $top: "100",
    }
  );

  let pushed = 0;
  let failed = 0;

  for (const event of events) {
    const payload: IngestCalendarPayload = {
      title: event.subject || "Untitled event",
      startAt: toUtcIso(event.start.dateTime, event.start.timeZone),
      endAt: toUtcIso(event.end.dateTime, event.end.timeZone),
      calendarName: event.calendar?.name ?? "Calendar",
      isAllDay: event.isAllDay,
      externalId: event.id,
    };

    const ok = await postToIngest(env, "/ingest/calendar", payload);
    if (ok) pushed++;
    else failed++;
  }

  return { pushed, failed };
}

// ---------------------------------------------------------------------------
// Graph write helpers
// ---------------------------------------------------------------------------

async function graphPost<T>(
  token: string,
  path: string,
  body: unknown
): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph POST ${path} failed ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function graphPatch(
  token: string,
  path: string,
  body: unknown
): Promise<void> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph PATCH ${path} failed ${res.status}: ${text}`);
  }
}

async function createTask(
  env: Env,
  listId: string,
  title: string,
  dueDate?: string
): Promise<{ id: string; title: string }> {
  const token = await getAccessToken(env);

  const body: Record<string, unknown> = { title };
  if (dueDate) {
    body.dueDateTime = { dateTime: dueDate, timeZone: "UTC" };
  }

  return graphPost<{ id: string; title: string }>(
    token,
    `/users/${env.MS_USER_ID}/todo/lists/${encodeURIComponent(listId)}/tasks`,
    body
  );
}

async function completeTask(
  env: Env,
  listId: string,
  taskId: string
): Promise<void> {
  const token = await getAccessToken(env);

  await graphPatch(
    token,
    `/users/${env.MS_USER_ID}/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`,
    { status: "completed" }
  );
}

async function getDefaultTaskListId(env: Env): Promise<string> {
  const token = await getAccessToken(env);
  const lists = await graphGetAll<TodoList>(token, `/users/${env.MS_USER_ID}/todo/lists`);
  const defaultList = lists.find((l) => l.wellknownListName === "defaultList");
  if (!defaultList) throw new Error("No default To Do list found");
  return defaultList.id;
}

// ---------------------------------------------------------------------------
// Ingest worker HTTP client
// ---------------------------------------------------------------------------

async function postToIngest(
  env: Env,
  path: string,
  payload: unknown
): Promise<boolean> {
  const url = env.INGEST_URL.replace(/\/$/, "") + path;
  const target = env.INGEST_SERVICE ? `http://ingest${path}` : url;

  try {
    const request = new Request(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.INGEST_API_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });

    const res = env.INGEST_SERVICE
      ? await env.INGEST_SERVICE.fetch(request)
      : await fetch(request);

    if (res.status < 200 || res.status > 299) {
      const body = await res.text();
      console.error(`ingest ${path} failed status=${res.status} body=${body}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`ingest ${path} fetch error: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  // Health check endpoint — useful for wrangler dev testing
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "GET" && pathname === "/health") {
      return new Response(
        JSON.stringify({ ok: true, service: "microsoft-graph-sync-worker" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Allow manually triggering a sync via POST /run (for testing)
    if (request.method === "POST" && pathname === "/run") {
      const result = await runSync(env);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Create a new task in Microsoft To Do
    if (request.method === "POST" && pathname === "/tasks/create") {
      try {
        const body = (await request.json()) as { title?: string; dueDate?: string; listId?: string };
        if (!body.title) {
          return new Response(JSON.stringify({ error: "title is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const listId = body.listId ?? (await getDefaultTaskListId(env));
        const created = await createTask(env, listId, body.title, body.dueDate);
        return new Response(JSON.stringify({ ok: true, task: created }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Error creating Microsoft To Do task", err);
        return new Response(JSON.stringify({ error: "Failed to create task" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Complete a task in Microsoft To Do
    if (request.method === "POST" && pathname === "/tasks/complete") {
      try {
        const body = (await request.json()) as { taskId?: string; listId?: string };
        if (!body.taskId) {
          return new Response(JSON.stringify({ error: "taskId is required" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        const listId = body.listId ?? (await getDefaultTaskListId(env));
        await completeTask(env, listId, body.taskId);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      } catch (err) {
        console.error("Error completing Microsoft To Do task", err);
        return new Response(JSON.stringify({ error: "Failed to complete task" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runSync(env));
  },
};

async function runSync(env: Env): Promise<{
  ok: boolean;
  tasks: { pushed: number; failed: number };
  calendar: { pushed: number; failed: number };
  error?: string;
}> {
  try {
    console.log("microsoft-graph-sync: starting sync");
    const token = await getAccessToken(env);

    const [taskResult, calendarResult] = await Promise.all([
      syncTodoTasks(token, env),
      syncCalendarEvents(token, env),
    ]);

    console.log(
      `microsoft-graph-sync: tasks pushed=${taskResult.pushed} failed=${taskResult.failed}`,
      `calendar pushed=${calendarResult.pushed} failed=${calendarResult.failed}`
    );

    return { ok: true, tasks: taskResult, calendar: calendarResult };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`microsoft-graph-sync: fatal error: ${message}`);
    return {
      ok: false,
      tasks: { pushed: 0, failed: 0 },
      calendar: { pushed: 0, failed: 0 },
      error: "Sync failed",
    };
  }
}
