import type { WeatherSnapshot } from "@reorgable/shared";

type NewsHeadline = {
  title: string;
  source?: string;
  publishedAt?: string;
};

type IngestedItem = {
  id: string;
  source_type: "task" | "document" | "email" | "note" | "calendar";
  title: string;
  summary_input: string;
  metadata_json: string;
  created_at: string;
};

const WEATHER_LABELS: Partial<Record<number, string>> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 48: "Icy fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow",
  75: "Heavy snow", 77: "Snow grains", 80: "Rain showers", 81: "Showers",
  82: "Heavy showers", 85: "Snow showers", 86: "Heavy snow showers",
  95: "Thunderstorm", 96: "Thunderstorm with hail", 99: "Thunderstorm with heavy hail",
};

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const url =
    "https://api.open-meteo.com/v1/forecast?latitude=47.8209&longitude=-122.3151&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Los_Angeles&forecast_days=1";
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo request failed: ${response.status}`);
  }

  const body = (await response.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] };
  };

  const hourly: WeatherSnapshot["hourly"] = [];
  const times = body.hourly?.time ?? [];
  const temps = body.hourly?.temperature_2m ?? [];
  const codes = body.hourly?.weather_code ?? [];
  for (let i = 0; i < times.length; i++) {
    const hour = parseInt(times[i].split("T")[1].split(":")[0], 10);
    if (hour >= 6 && hour <= 21) {
      hourly.push({ hour, tempF: temps[i] ?? 0, weatherCode: codes[i] ?? -1 });
    }
  }

  const forecastTemps = temps.filter((temp) => typeof temp === "number");
  const highF = forecastTemps.length ? Math.max(...forecastTemps) : body.current?.temperature_2m ?? 0;
  const lowF = forecastTemps.length ? Math.min(...forecastTemps) : body.current?.temperature_2m ?? 0;

  return {
    highF,
    lowF,
    weatherCode: body.current?.weather_code ?? -1,
    hourly,
  };
}

export async function fetchTopHeadlines(apiKey?: string): Promise<NewsHeadline[]> {
  if (!apiKey) return [];

  try {
    const response = await fetch(
      "https://newsapi.org/v2/top-headlines?country=us&pageSize=5",
      {
        headers: {
          "X-Api-Key": apiKey,
        },
      }
    );

    if (!response.ok) return [];

    const body = (await response.json()) as {
      articles?: Array<{
        title?: string;
        source?: { name?: string };
        publishedAt?: string;
      }>;
    };

    return (body.articles ?? [])
      .map((article) => ({
        title: article.title ?? "",
        source: article.source?.name,
        publishedAt: article.publishedAt,
      }))
      .filter((article) => article.title.trim().length > 0)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function getItemsSinceCursor(env: { DB: D1Database }, cursor: string): Promise<IngestedItem[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at
     FROM items
     WHERE created_at > ?1
     ORDER BY created_at ASC`
  )
    .bind(cursor)
    .all<IngestedItem>();

  return results ?? [];
}

export async function getOutstandingTasks(env: { DB: D1Database }): Promise<IngestedItem[]> {
  // Staleness guard: tasks from sync sources (Google Tasks, MS Todo) refresh
  // created_at on every push (~15 min interval). If a task hasn't been refreshed
  // in 4 hours (~16 missed cycles), the source likely completed/deleted it.
  // Microsoft tasks rely entirely on this guard (no closed-task push).
  const { results } = await env.DB.prepare(
    `SELECT id, source_type, title, summary_input, metadata_json, created_at
     FROM items
     WHERE source_type = 'task'
       AND COALESCE(json_extract(metadata_json, '$.isDone'), 0) != 1
       AND created_at > datetime('now', '-4 hours')
     ORDER BY created_at ASC`
  ).all<IngestedItem>();

  return results ?? [];
}

export async function getItemsSinceLastRun(
  env: { DB: D1Database; STATE_KV: KVNamespace },
  cursorOverride?: string
): Promise<{ items: IngestedItem[]; cursor: string }> {
  const fallbackCursor = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const cursor = cursorOverride ?? (await env.STATE_KV.get("last_report_at")) ?? fallbackCursor;

  const [recentItems, outstandingTasks] = await Promise.all([
    getItemsSinceCursor(env, cursor),
    getOutstandingTasks(env)
  ]);

  const merged = new Map<string, IngestedItem>();
  for (const item of recentItems) merged.set(item.id, item);
  for (const item of outstandingTasks) merged.set(item.id, item);

  return {
    items: Array.from(merged.values()).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    cursor
  };
}

export function describeWeather(weather: WeatherSnapshot): string {
  const label = WEATHER_LABELS[weather.weatherCode] ?? `WMO ${weather.weatherCode}`;
  return `high ${weather.highF.toFixed(0)}F, low ${weather.lowF.toFixed(0)}F, ${label}`;
}

export type { NewsHeadline, IngestedItem, WeatherSnapshot };
