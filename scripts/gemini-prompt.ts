import type { WeatherSnapshot } from "../packages/shared/src/index";

type NewsHeadline = {
  title: string;
  source?: string;
  publishedAt?: string;
};

type CalendarConflict = {
  eventA: string;
  eventB: string;
  overlapMinutes: number;
};

type EngagementSummary = {
  briefName: string;
  uploadedAt: string;
  stillOnDevice: boolean;
  deletedAt?: string;
  lastSeenAt?: string;
  retentionHours?: number;
};

const WEATHER_LABELS: Partial<Record<number, string>> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow",
  75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Showers",
  82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

function describeWeather(weather: WeatherSnapshot): string {
  const label = WEATHER_LABELS[weather.weatherCode] ?? `WMO ${weather.weatherCode}`;
  return `high ${weather.highF.toFixed(0)}F, low ${weather.lowF.toFixed(0)}F, ${label}`;
}

function formatPacificTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(iso));
}

function safeParseMetadata(metadata_json: string): Record<string, unknown> {
  try {
    const p = JSON.parse(metadata_json);
    return p && typeof p === "object" ? p : {};
  } catch {
    return {};
  }
}

export type InboxEmailSummaryItem = {
  from: string;
  subject: string;
  preview: string;
  sentAt?: string;
  isLinkedToTask: boolean;
};

export type EntityEntry = { name: string; type: string; definition: string };

export function buildGeminiPrompt(
  compact: Array<{ id: string; type: string; title: string; text: string; metadata: Record<string, unknown>; createdAt: string }>,
  weather: WeatherSnapshot,
  dateLabel: string,
  previousOverview?: string,
  conflicts?: CalendarConflict[],
  engagement?: EngagementSummary,
  operatorContext?: string,
  headlines?: NewsHeadline[],
  inboxEmails?: InboxEmailSummaryItem[],
  entityDictionary?: EntityEntry[],
): string {
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
    "- inboxSummary: if inbox emails are provided below, summarize traffic and highlight follow-ups not covered by tasks. Omit this field if no inbox emails are provided.",
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

  if (entityDictionary?.length) {
    lines.push("", "Known entities (use these definitions for context when interpreting items):");
    for (const entity of entityDictionary) {
      lines.push(`- ${entity.name} [${entity.type}]: ${entity.definition}`);
    }
  }

  if (inboxEmails?.length) {
    lines.push("", "Inbox emails (last 24 hours — summarize in inboxSummary, highlight items needing follow-up):");
    for (const email of inboxEmails) {
      const linked = email.isLinkedToTask ? " [linked to task]" : "";
      const sent = email.sentAt ? ` sent ${email.sentAt}` : "";
      lines.push(`- From: ${email.from}${sent} | Subject: ${email.subject}${linked}`);
      if (email.preview) lines.push(`  Preview: ${email.preview}`);
    }
  }

  lines.push("", "Input items:", JSON.stringify(compact));

  return lines.join("\n");
}

export type { NewsHeadline, CalendarConflict, EngagementSummary, InboxEmailSummaryItem, EntityEntry };
