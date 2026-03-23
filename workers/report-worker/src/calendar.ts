import type { IngestedItem, WeatherSnapshot } from "./fetchers";

type CalendarEvent = {
  title: string;
  startAt: string;
  endAt: string;
  startLabel: string;
  endLabel: string;
  calendarName: string;
};

type CalendarConflict = {
  eventA: string;
  eventB: string;
  overlapMinutes: number;
};

const PACIFIC_TIMEZONE = "America/Los_Angeles";

const WEATHER_LABELS: Partial<Record<number, string>> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow",
  75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Showers",
  82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\s@.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function safeParseMetadata(item: IngestedItem): Record<string, unknown> {
  try {
    const parsed = JSON.parse(item.metadata_json);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function toPacificDateKey(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date(iso));
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

export function formatPacificTime(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(new Date(iso));
}

export function describeWeather(weather: WeatherSnapshot): string {
  const label = WEATHER_LABELS[weather.weatherCode] ?? `WMO ${weather.weatherCode}`;
  return `high ${weather.highF.toFixed(0)}F, low ${weather.lowF.toFixed(0)}F, ${label}`;
}

export function buildCalendarAgenda(items: IngestedItem[], now: Date): CalendarEvent[] {
  const todayKey = toPacificDateKey(now.toISOString());

  const events = items
    .filter((item) => item.source_type === "calendar")
    .map((item) => {
      const m = safeParseMetadata(item);
      const startAt = m.startAt as string | undefined;
      const endAt = m.endAt as string | undefined;
      if (!startAt || !endAt) return null;
      return {
        title: item.title,
        startAt,
        endAt,
        calendarName: (m.calendarName as string) ?? "Calendar"
      };
    })
    .filter((v): v is { title: string; startAt: string; endAt: string; calendarName: string } => !!v)
    .filter((event) => toPacificDateKey(event.startAt) === todayKey);

  const dedupedEvents = new Map<string, { title: string; startAt: string; endAt: string; calendarName: string }>();
  for (const event of events) {
    const key = `${normalizeForMatch(event.title)}|${new Date(event.startAt).getTime()}|${new Date(event.endAt).getTime()}`;
    const existing = dedupedEvents.get(key);
    if (!existing) {
      dedupedEvents.set(key, event);
      continue;
    }
    if (existing.calendarName === "Calendar" && event.calendarName !== "Calendar") {
      dedupedEvents.set(key, event);
    }
  }

  return Array.from(dedupedEvents.values())
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .slice(0, 30)
    .map((event) => ({
      ...event,
      startLabel: formatPacificTime(event.startAt),
      endLabel: formatPacificTime(event.endAt)
    }));
}

export function detectCalendarConflicts(events: CalendarEvent[]): CalendarConflict[] {
  const conflicts: CalendarConflict[] = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      const aStart = new Date(a.startAt).getTime();
      const aEnd = new Date(a.endAt).getTime();
      const bStart = new Date(b.startAt).getTime();
      const bEnd = new Date(b.endAt).getTime();

      const overlapStart = Math.max(aStart, bStart);
      const overlapEnd = Math.min(aEnd, bEnd);
      if (overlapStart < overlapEnd) {
        conflicts.push({
          eventA: a.title,
          eventB: b.title,
          overlapMinutes: Math.round((overlapEnd - overlapStart) / 60_000),
        });
      }
    }
  }
  return conflicts;
}

export type { CalendarEvent, CalendarConflict };
