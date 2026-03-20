import { z } from "zod";

export const reportOutputSchema = z.object({
  overview: z.string().min(1),
  agenda: z.array(z.string().min(1)).min(1).max(12),
  todos: z.array(z.object({
    task: z.string().min(1),
    done: z.boolean().default(false)
  })).max(20),
  followUps: z.array(z.string().min(1)).max(10)
});

export type ReportOutput = z.infer<typeof reportOutputSchema>;

export const reportOutputJsonSchema = {
  type: "object",
  properties: {
    overview: { type: "string", description: "2-5 sentence overview of today." },
    agenda: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 12,
      description: "Ordered day agenda bullets."
    },
    todos: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          task: { type: "string" },
          done: { type: "boolean" }
        },
        required: ["task", "done"]
      }
    },
    followUps: {
      type: "array",
      items: { type: "string" },
      maxItems: 10,
      description: "Calls, emails, and follow-up actions."
    }
  },
  required: ["overview", "agenda", "todos", "followUps"]
} as const;
