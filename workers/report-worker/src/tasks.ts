import type { IngestedItem } from "./fetchers";
import { mapAndFilterTaskItems, groupTasksByTitle, findKeysToKeep, buildTaskResult } from "./task-helpers";

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

type ReferenceItem = {
  source: string;
  title: string;
  body: string;
  meta?: string;
};

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

export function filterItemsForBrief(items: IngestedItem[]): IngestedItem[] {
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

export function buildGoogleTaskTodos(items: IngestedItem[]): Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> {
  const taskItems = mapAndFilterTaskItems(items);
  const groups = groupTasksByTitle(taskItems);
  const keepOpenKeys = findKeysToKeep(groups);

  const filteredTaskItems = taskItems.filter((todo) => {
    if (todo.done) return true;
    const parentKey = todo.parentTaskId ?? "__root__";
    const groupKey = `${parentKey}|${todo.normalizedTitle}`;
    const entryKey = `${groupKey}|${todo.externalId ?? todo.createdAt}`;
    return keepOpenKeys.has(entryKey);
  });

  return buildTaskResult(filteredTaskItems);
}

export function buildNoteLines(items: IngestedItem[]): string[] {
  return items
    .filter((item) => item.source_type === "note")
    .map((item) => item.summary_input.trim())
    .filter(Boolean)
    .slice(0, 18);
}

export function buildReferenceItems(items: IngestedItem[]): ReferenceItem[] {
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

export type { ItemMetadata, ReferenceItem };

export interface InboxEmailSummaryItem {
  from: string;
  subject: string;
  preview: string;
  sentAt?: string;
  isLinkedToTask: boolean;
}

export function buildInboxSummary(items: IngestedItem[]): InboxEmailSummaryItem[] {
  const tasks = items.filter((item) => item.source_type === "task");
  const openTasks = tasks.filter((item) => safeParseMetadata(item).isDone !== true);
  const inboxEmails = items.filter((item) => {
    if (item.source_type !== "email") return false;
    const metadata = safeParseMetadata(item);
    return metadata.inInbox === true;
  });

  return inboxEmails.map((email) => {
    const meta = safeParseMetadata(email);
    const linked = openTasks.some((task) => emailIsLinkedToTask(task, email));
    return {
      from: (meta.from as string) ?? "unknown",
      subject: email.title,
      preview: email.summary_input.slice(0, 300),
      sentAt: (meta.sentAt as string) ?? undefined,
      isLinkedToTask: linked,
    };
  });
}
