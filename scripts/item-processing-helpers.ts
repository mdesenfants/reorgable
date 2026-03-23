/**
 * Item processing helpers extracted from preview-live.ts
 */

export type IngestedItem = {
  id: string;
  source_type: "task" | "document" | "email" | "note" | "calendar";
  title: string;
  summary_input: string;
  metadata_json: string;
  created_at: string;
};

export type ItemMetadata = {
  isDone?: boolean;
  isUnread?: boolean;
  inInbox?: boolean;
  tags?: string[];
  relatedEmailSubject?: string;
  relatedEmailFrom?: string;
  relatedEmailMessageId?: string;
  from?: string;
  to?: string;
  startAt?: string;
  endAt?: string;
  calendarName?: string;
  externalId?: string;
  parentTaskId?: string;
  dueAt?: string;
};

const TASK_SOURCE_TAGS = ["google-tasks", "microsoft-todo", "microsoft-flagged-email"];

export function safeParseMetadata(item: IngestedItem): ItemMetadata {
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
  const stop = new Set([
    "the", "and", "for", "with", "from", "that", "this", "have", "will", "your",
    "about", "reply", "email", "thread", "follow", "message"
  ]);
  return new Set(
    normalizeForMatch(v).split(" ").filter(w => w.length >= 4 && !stop.has(w))
  );
}

function overlapCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

export function emailIsLinkedToTask(task: IngestedItem, email: IngestedItem): boolean {
  const tm = safeParseMetadata(task);
  const em = safeParseMetadata(email);
  
  if (tm.relatedEmailMessageId && em.externalId &&
      normalizeForMatch(tm.relatedEmailMessageId) === normalizeForMatch(em.externalId)) {
    return true;
  }
  
  const titleTokens = tokenize(task.title);
  const emailTokens = tokenize(email.title);
  if (titleTokens.size >= 2 && emailTokens.size >= 2 && overlapCount(titleTokens, emailTokens) >= 2) {
    return true;
  }
  
  if (tm.relatedEmailFrom && em.from && normalizeForMatch(tm.relatedEmailFrom) === normalizeForMatch(em.from)) {
    if (tm.relatedEmailSubject && overlapCount(tokenize(tm.relatedEmailSubject), emailTokens) >= 2) {
      return true;
    }
  }
  
  return false;
}

export function filterItemsForBrief(items: IngestedItem[]): IngestedItem[] {
  const tasks = items.filter(i => i.source_type === "task");
  const nonEmails = items.filter(i => i.source_type !== "email");
  const inboxEmails = items.filter(i => {
    if (i.source_type !== "email") return false;
    return safeParseMetadata(i).inInbox === true;
  });
  
  const openTasks = tasks.filter(i => safeParseMetadata(i).isDone !== true);
  const matchedIds = new Set<string>();
  
  for (const task of openTasks) {
    for (const email of inboxEmails) {
      if (emailIsLinkedToTask(task, email)) {
        matchedIds.add(email.id);
      }
    }
  }
  
  const linked = inboxEmails.filter(e => matchedIds.has(e.id));
  return [...nonEmails, ...linked].sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function buildGoogleTaskTodos(items: IngestedItem[]) {
  const taskItems = items
    .filter(i => i.source_type === "task")
    .map(i => {
      const m = safeParseMetadata(i);
      return {
        task: i.title,
        done: m.isDone === true,
        isKnownTask: (m.tags ?? []).some(t => TASK_SOURCE_TAGS.includes(t)),
        externalId: m.externalId ?? null,
        parentTaskId: m.parentTaskId ?? null,
        dueAt: m.dueAt
      };
    })
    .filter(t => t.isKnownTask);
  
  const parentIds = new Set(taskItems.map(t => t.externalId).filter(Boolean));
  const result: Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> = [];
  
  for (const t of taskItems) {
    if (t.parentTaskId) continue;
    result.push({ task: t.task, done: t.done, isSubtask: false, dueAt: t.dueAt });
    for (const s of taskItems) {
      if (s.parentTaskId === t.externalId) {
        result.push({ task: s.task, done: s.done, isSubtask: true, dueAt: s.dueAt });
      }
    }
  }
  
  for (const t of taskItems) {
    if (t.parentTaskId && !parentIds.has(t.parentTaskId)) {
      result.push({ task: t.task, done: t.done, isSubtask: true, dueAt: t.dueAt });
    }
  }
  
  return result.slice(0, 25);
}

export function buildNoteLines(items: IngestedItem[]): string[] {
  return items
    .filter(i => i.source_type === "note")
    .map(i => i.summary_input.trim())
    .filter(Boolean)
    .slice(0, 18);
}
