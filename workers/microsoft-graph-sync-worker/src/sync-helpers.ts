/**
 * Sync operation helpers extracted from index.ts
 */

export interface TodoList {
  id: string;
  displayName: string;
  wellknownListName: string;
}

export interface TodoTask {
  id: string;
  title: string;
  status?: string;
  importance?: "low" | "normal" | "high";
  body?: { content?: string; contentType?: string };
  dueDateTime?: { dateTime: string; timeZone: string };
  parentList?: { id: string };
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isAllDay: boolean;
  calendar?: { name: string };
}

export interface IngestTaskPayload {
  title: string;
  details?: string;
  dueAt?: string;
  priority: "low" | "medium" | "high";
  tags: string[];
  isDone: boolean;
  externalId: string;
}

export interface IngestCalendarPayload {
  title: string;
  startAt: string;
  endAt: string;
  calendarName: string;
  isAllDay: boolean;
  externalId: string;
}

export function mapImportance(importance: TodoTask["importance"]): "low" | "medium" | "high" {
  if (!importance) return "medium";
  if (importance === "high") return "high";
  if (importance === "low") return "low";
  return "medium";
}

export function toUtcIso(dateTime: string, _timeZone: string): string {
  if (dateTime.endsWith("Z") || dateTime.includes("+")) return dateTime;
  return dateTime + "Z";
}

export function getTodayDateRange(): { start: string; end: string } {
  const now = new Date();
  const todayStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
  ).toISOString();
  const todayEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 23, 59, 59)
  ).toISOString();
  return { start: todayStart, end: todayEnd };
}

export function buildTaskPayload(task: TodoTask, tag: string): IngestTaskPayload {
  return {
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
}

export function buildCalendarPayload(event: CalendarEvent): IngestCalendarPayload {
  return {
    title: event.subject || "Untitled event",
    startAt: toUtcIso(event.start.dateTime, event.start.timeZone),
    endAt: toUtcIso(event.end.dateTime, event.end.timeZone),
    calendarName: event.calendar?.name ?? "Calendar",
    isAllDay: event.isAllDay,
    externalId: event.id,
  };
}
