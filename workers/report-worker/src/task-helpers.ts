/**
 * Task processing helpers extracted from tasks.ts
 */

import type { IngestedItem } from "./fetchers";

type TaskItem = {
  task: string;
  done: boolean;
  isKnownTask: boolean;
  externalId: string | null;
  parentTaskId: string | null;
  dueAt: string | undefined;
  normalizedTitle: string;
  createdAt: string;
};

const TASK_SOURCE_TAGS = ["google-tasks", "microsoft-todo", "microsoft-flagged-email"];

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s@.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeParseMetadata(item: IngestedItem) {
  try {
    return JSON.parse(item.metadata_json);
  } catch {
    return {};
  }
}

export function mapAndFilterTaskItems(items: IngestedItem[]): TaskItem[] {
  return items
    .filter((item) => item.source_type === "task")
    .map((item) => {
      const m = safeParseMetadata(item);
      const tags = m.tags ?? [];
      return {
        task: item.title,
        done: m.isDone === true,
        isKnownTask: tags.some((t: string) => TASK_SOURCE_TAGS.includes(t)),
        externalId: m.externalId ?? null,
        parentTaskId: m.parentTaskId ?? null,
        dueAt: m.dueAt ?? undefined,
        normalizedTitle: normalizeForMatch(item.title),
        createdAt: item.created_at
      };
    })
    .filter((todo) => todo.isKnownTask)
    .filter((todo) => !(todo.parentTaskId && todo.done));
}

export function sortTasksByDueDate(left: TaskItem, right: TaskItem): number {
  const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.NEGATIVE_INFINITY;
  const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.NEGATIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return left.createdAt.localeCompare(right.createdAt);
}

export function groupTasksByTitle(taskItems: TaskItem[]): Map<string, TaskItem[]> {
  const groups = new Map<string, TaskItem[]>();
  for (const todo of taskItems) {
    if (todo.done) continue;
    const parentKey = todo.parentTaskId ?? "__root__";
    const groupKey = `${parentKey}|${todo.normalizedTitle}`;
    const group = groups.get(groupKey) ?? [];
    group.push(todo);
    groups.set(groupKey, group);
  }
  return groups;
}

export function findKeysToKeep(groups: Map<string, TaskItem[]>): Set<string> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const keepOpenKeys = new Set<string>();

  for (const [groupKey, group] of groups.entries()) {
    const sorted = group.slice().sort(sortTasksByDueDate);
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
    } else {
      keepOpenKeys.add(`${groupKey}|${latest.externalId ?? latest.createdAt}`);
    }
  }
  return keepOpenKeys;
}

export function buildTaskResult(filteredTaskItems: TaskItem[]): Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> {
  const parentIds = new Set(filteredTaskItems.map((t) => t.externalId).filter(Boolean));
  const result: Array<{ task: string; done: boolean; isSubtask: boolean; dueAt?: string }> = [];

  for (const todo of filteredTaskItems) {
    if (todo.parentTaskId) continue;
    result.push({ task: todo.task, done: todo.done, isSubtask: false, dueAt: todo.dueAt });
    for (const sub of filteredTaskItems) {
      if (sub.parentTaskId === todo.externalId) {
        result.push({ task: sub.task, done: sub.done, isSubtask: true, dueAt: sub.dueAt });
      }
    }
  }

  for (const todo of filteredTaskItems) {
    if (todo.parentTaskId && !parentIds.has(todo.parentTaskId)) {
      result.push({ task: todo.task, done: todo.done, isSubtask: true, dueAt: todo.dueAt });
    }
  }

  return result.slice(0, 25);
}
