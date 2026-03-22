import { z } from "zod";

export const reportOutputSchema = z.object({
  overview: z.string().min(1),
  deltaSinceYesterday: z.string().min(1),
});

export type ReportOutput = z.infer<typeof reportOutputSchema>;

export const reportOutputJsonSchema = {
  type: "object",
  properties: {
    overview: { type: "string", description: "2-5 sentence executive summary covering key meetings, tasks, and priorities." },
    deltaSinceYesterday: {
      type: "string",
      description: "1-3 sentences summarizing what changed since the previous brief: new items, resolved tasks, shifted deadlines."
    }
  },
  required: ["overview", "deltaSinceYesterday"]
} as const;
