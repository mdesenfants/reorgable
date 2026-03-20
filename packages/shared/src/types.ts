import { z } from "zod";

export const sourceTypeSchema = z.enum(["task", "document", "email", "note", "calendar"]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const taskIngestSchema = z.object({
  title: z.string().min(1),
  details: z.string().optional(),
  dueAt: z.string().datetime().optional(),
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  tags: z.array(z.string()).default([]),
  isDone: z.boolean().default(false),
  relatedEmailSubject: z.string().min(1).optional(),
  relatedEmailFrom: z.string().email().optional(),
  relatedEmailMessageId: z.string().min(1).optional(),
  externalId: z.string().optional()
});

export const documentIngestSchema = z.object({
  title: z.string().min(1),
  mimeType: z.string().min(1),
  r2Key: z.string().min(1),
  summaryHint: z.string().optional(),
  externalId: z.string().optional()
});

export const emailIngestSchema = z.object({
  from: z.string().email(),
  to: z.string().email(),
  subject: z.string().min(1),
  bodyText: z.string().optional(),
  bodyHtml: z.string().optional(),
  sentAt: z.string().datetime().optional(),
  attachmentKeys: z.array(z.string()).default([]),
  isUnread: z.boolean().default(false),
  inInbox: z.boolean().default(false),
  isStarred: z.boolean().default(false),
  externalId: z.string().optional()
});

export const noteIngestSchema = z.object({
  title: z.string().min(1).default("Note"),
  text: z.string().min(1),
  tags: z.array(z.string()).default([]),
  externalId: z.string().optional()
});

export const calendarIngestSchema = z.object({
  title: z.string().min(1),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  calendarName: z.string().min(1),
  isAllDay: z.boolean().default(false),
  externalId: z.string().optional()
});

export const storedItemPayloadSchema = z.object({
  id: z.string(),
  sourceType: sourceTypeSchema,
  title: z.string(),
  createdAt: z.string(),
  summaryInput: z.string(),
  metadataJson: z.string()
});

export type TaskIngest = z.infer<typeof taskIngestSchema>;
export type DocumentIngest = z.infer<typeof documentIngestSchema>;
export type EmailIngest = z.infer<typeof emailIngestSchema>;
export type NoteIngest = z.infer<typeof noteIngestSchema>;
export type CalendarIngest = z.infer<typeof calendarIngestSchema>;
export type StoredItemPayload = z.infer<typeof storedItemPayloadSchema>;
