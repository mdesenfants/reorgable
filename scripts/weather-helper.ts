/**
 * Weather fetching helper extracted from preview-live.ts
 */

import type { WeatherSnapshot } from "@reorgable/shared";

export async function fetchWeather(): Promise<WeatherSnapshot> {
  const url = "https://api.open-meteo.com/v1/forecast?latitude=47.8209&longitude=-122.3151&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=America/Los_Angeles&forecast_days=1";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo failed: ${res.status}`);
  const body = await res.json() as { current?: { temperature_2m?: number; weather_code?: number }; hourly?: { time?: string[]; temperature_2m?: number[]; weather_code?: number[] } };
  const hourly: WeatherSnapshot["hourly"] = [];
  const times = body.hourly?.time ?? [], temps = body.hourly?.temperature_2m ?? [], codes = body.hourly?.weather_code ?? [];
  for (let i = 0; i < times.length; i++) {
    const h = parseInt(times[i].split("T")[1].split(":")[0], 10);
    if (h >= 6 && h <= 21) hourly.push({ hour: h, tempF: temps[i] ?? 0, weatherCode: codes[i] ?? -1 });
  }
  const forecastTemps = temps.filter((temp) => typeof temp === "number");
  const highF = forecastTemps.length ? Math.max(...forecastTemps) : body.current?.temperature_2m ?? 0;
  const lowF = forecastTemps.length ? Math.min(...forecastTemps) : body.current?.temperature_2m ?? 0;
  return { highF, lowF, weatherCode: body.current?.weather_code ?? -1, hourly };
}
