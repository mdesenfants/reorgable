import { reportOutputSchema, reportOutputJsonSchema, type ReportOutput, type WeatherSnapshot } from "@reorgable/shared";
import type { IngestedItem } from "./fetchers";
import type { CalendarConflict } from "./calendar";
import { formatPacificTime, describeWeather } from "./calendar";

type NewsHeadline = {
  title: string;
  source?: string;
  publishedAt?: string;
};

type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

function safeParseMetadata(item: IngestedItem): Record<string, unknown> {
  try {
    const parsed = JSON.parse(item.metadata_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function extractJsonObject(text: string): string {
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Gemini response did not contain a JSON object");
  }
  return text.slice(firstBrace, lastBrace + 1);
}

export function buildGeminiPrompt(
  items: IngestedItem[],
  weather: WeatherSnapshot,
  dateLabel: string,
  previousOverview?: string,
  conflicts?: CalendarConflict[],
  engagement?: EngagementSummary,
  operatorContext?: string,
  headlines?: NewsHeadline[]
): string {
  const compact = items.map((item) => {
    const meta = safeParseMetadata(item);
    if (item.source_type === "calendar" && meta.startAt && meta.endAt) {
      const startPT = formatPacificTime(meta.startAt as string);
      const endPT = formatPacificTime(meta.endAt as string);
      return {
        id: item.id,
        type: item.source_type,
        title: item.title,
        text: `${startPT} - ${endPT} (${(meta.calendarName as string) ?? "Calendar"}) ${item.title}\n${item.summary_input}`,
        metadata: { ...meta, startAtPacific: startPT, endAtPacific: endPT },
        createdAt: item.created_at
      };
    }
    return {
      id: item.id,
      type: item.source_type,
      title: item.title,
      text: item.summary_input,
      metadata: meta,
      createdAt: item.created_at
    };
  });

  const lines = [
    "You are generating a fixed-format daily brief.",
    `Date: ${dateLabel}`,
    `Timezone: Pacific Time (America/Los_Angeles)`,
    `Weather: ${describeWeather(weather)} (code ${weather.weatherCode})`,
    "Return JSON matching the schema exactly.",
    "Guidance:",
    "- overview: concise executive summary covering key meetings, tasks, and priorities.",
    "- overview: the first sentence must describe today's weather using the daily high/low and condition.",
    "- deltaSinceYesterday: summarize what changed since yesterday — new items added, tasks resolved, deadlines shifted.",
    "- use the full content of emails and calendar events to understand what tasks entail",
    "- focus on key dependencies and communication risk",
    "- all times shown are already in Pacific Time",
    "- overview: if top headlines are provided below, include a brief 'In the News' closing sentence.",
    "- overview: prioritize major US news, international news, science, technology, business, and Seattle sports.",
  ];

  if (operatorContext) {
    lines.push("", "Operator guidance (follow these instructions from the user):", operatorContext);
  }

  if (previousOverview) {
    lines.push("", "Yesterday's brief overview (for delta comparison):", previousOverview);
  }

  if (conflicts?.length) {
    lines.push("", "⚠ Calendar conflicts detected (warn the user about these overlapping meetings):");
    for (const c of conflicts) {
      lines.push(`- "${c.eventA}" and "${c.eventB}" overlap by ${c.overlapMinutes} minutes`);
    }
  }

  if (engagement) {
    const status = engagement.stillOnDevice
      ? `still on device (last seen ${engagement.retentionHours ?? "?"}h after upload)`
      : `removed from device after ${engagement.retentionHours ?? "?"}h`;
    lines.push("", `📊 Previous brief engagement: "${engagement.briefName}" was ${status}.`);
    if (!engagement.stillOnDevice && engagement.retentionHours !== undefined && engagement.retentionHours < 1) {
      lines.push("  The user deleted the brief quickly — consider being more concise today.");
    }
  }

  if (headlines?.length) {
    lines.push("", "Top headlines (MUST include a 1–2 sentence 'In the News' summary of these in the overview):");
    for (const headline of headlines) {
      const source = headline.source ? ` (${headline.source})` : "";
      lines.push(`- ${headline.title}${source}`);
    }
  }

  lines.push("", "Input items:", JSON.stringify(compact));

  return lines.join("\n");
}

export async function summarizeWithGemini(
  env: { GEMINI_API_KEY: string; GEMINI_MODEL?: string },
  items: IngestedItem[],
  weather: WeatherSnapshot,
  dateLabel: string,
  previousOverview?: string,
  conflicts?: CalendarConflict[],
  engagement?: EngagementSummary,
  operatorContext?: string,
  headlines?: NewsHeadline[]
): Promise<ReportOutput> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const model = env.GEMINI_MODEL ?? "gemini-3-flash-preview";
  const prompt = buildGeminiPrompt(items, weather, dateLabel, previousOverview, conflicts, engagement, operatorContext, headlines);

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: reportOutputJsonSchema
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`Gemini call failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = body.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini response was empty");

  const parsed = JSON.parse(extractJsonObject(text));
  return reportOutputSchema.parse(parsed);
}

export type { NewsHeadline, EngagementSummary };
