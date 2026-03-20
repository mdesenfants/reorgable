// HTML report template.
// Used by scripts/preview-report.ts (local Puppeteer) and, in Phase 2,
// by the Cloudflare Worker via @cloudflare/puppeteer (Browser Rendering).

export interface TemplateData {
  dateLabel: string;
  weather: { tempF: number; weatherCode: number };
  overview: string;
  agendaEvents: Array<{
    title: string;
    startAt: string;
    endAt: string;
    startLabel: string;
    endLabel: string;
    calendarName: string;
  }>;
  todos: Array<{ task: string; done: boolean }>;
  followUps: string[];
  noteLines: string[];
}

/** Escape HTML special characters to prevent injection in rendered output. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// WMO weather interpretation codes → human-readable label.
const WMO: Partial<Record<number, string>> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Icy fog",
  51: "Light drizzle",
  53: "Drizzle",
  55: "Heavy drizzle",
  61: "Light rain",
  63: "Rain",
  65: "Heavy rain",
  71: "Light snow",
  73: "Snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Rain showers",
  81: "Showers",
  82: "Heavy showers",
  85: "Snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm w/ hail",
  99: "Thunderstorm w/ heavy hail",
};

function weatherLabel(code: number, tempF: number): string {
  const desc = WMO[code] ?? `WMO ${code}`;
  return `${tempF.toFixed(0)}°F · ${desc}`;
}

/**
 * Generate ruled lines as individual <hr> elements inside a custom element.
 * Real DOM nodes sidestep the Chromium PDF bug where repeating-linear-gradient
 * renders as a solid block when printing.
 */
function ruledLines(count: number): string {
  const lines = Array.from({ length: count }, () => "<hr>").join("");
  return `<ruled-lines>${lines}</ruled-lines>`;
}

/** Full-page ruled lines that stretch via flex to fill available height. */
function ruledLinesFill(count: number): string {
  const lines = Array.from({ length: count }, () => "<hr>").join("");
  return `<ruled-lines class="fill">${lines}</ruled-lines>`;
}

export function renderHtml(data: TemplateData): string {
  // Keep only active tasks for the check-list panel.
  const activeTodos = data.todos.filter((t) => !t.done);

  const agendaHtml = data.agendaEvents
    .map(
      (item, i) =>
        `<li><span class="item-num">${i + 1}.</span><span><strong>${esc(item.startLabel)}-${esc(item.endLabel)}</strong> ${esc(item.title)} <em>(${esc(item.calendarName)})</em></span></li>`
    )
    .join("\n          ");

  const todosHtml = activeTodos
    .map(
      (todo) =>
        `<div class="todo-item">` +
        `<span class="checkbox"></span>` +
        `<span>${esc(todo.task)}</span>` +
        `</div>`
    )
    .join("\n          ");

  const followUpsHtml = data.followUps
    .map((f) => `<li>${esc(f)}</li>`)
    .join("\n          ");

  const notesCaptureHtml = data.noteLines
    .map((line) => `<li>${esc(line)}</li>`)
    .join("\n          ");

  const dayStartMinutes = 6 * 60;
  const dayEndMinutes = 21 * 60;
  const dayDurationMinutes = dayEndMinutes - dayStartMinutes;
  const toMinutes = (iso: string): number => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).formatToParts(new Date(iso));
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    return hour * 60 + minute;
  };
  const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
  const calendarBlocks = data.agendaEvents
    .map((event) => {
      const start = clamp(toMinutes(event.startAt), dayStartMinutes, dayEndMinutes);
      const end = clamp(toMinutes(event.endAt), dayStartMinutes, dayEndMinutes);
      if (end <= start) return null;
      const topPct = ((start - dayStartMinutes) / dayDurationMinutes) * 100;
      const heightPct = ((end - start) / dayDurationMinutes) * 100;
      return `<div class="calendar-event" style="top:${topPct}%;height:${heightPct}%">${esc(event.title)} <span class="calendar-event-sep">|</span> ${esc(event.startLabel)}-${esc(event.endLabel)} <span class="calendar-event-sep">|</span> ${esc(event.calendarName)}</div>`;
    })
    .filter((v): v is string => !!v)
    .join("\n          ");

  const hourRows = Array.from({ length: 16 }, (_, i) => {
    const hour24 = 6 + i;
    const period = hour24 >= 12 ? "PM" : "AM";
    const hour12 = hour24 % 12 || 12;
    const label = `${hour12} ${period}`;
    const topPct = (i / 15) * 100;
    return `<div class="calendar-row" style="top:${topPct.toFixed(2)}%"><span class="calendar-row-label">${esc(label)}</span><span class="calendar-row-line"></span></div>`;
  }).join("\n          ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Daily Brief \u2013 ${esc(data.dateLabel)}</title>
  <style>
    /* ── Design System ─────────────────────────────────────────────── */
    @page {
      size: Letter;
      margin: 0.55in 0.65in 0.5in;
    }

    html, body { margin: 0; padding: 0; }

    body {
      font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
      font-size: 14pt;
      line-height: 1.5;
      color: #111;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Typography ────────────────────────────────────────────────── */
    h1.brief-title { font-size: 30pt; font-weight: 700; line-height: 1; margin: 0; }
    .section-title { font-size: 16pt; font-weight: 700; margin: 0 0 0.35em; color: #000; }
    .date-sub     { font-size: 14pt; color: #666; margin: 0.15em 0 0; }

    /* ── Utility (replaces Bootstrap) ──────────────────────────────── */
    .header-row {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    .section-gap { margin-bottom: 0.6em; }
    .divider {
      border: none;
      border-top: 1px solid #999;
      margin: 0.3em 0 0.6em;
    }

    /* ── Panels ────────────────────────────────────────────────────── */
    .panel {
      border: 1px solid #bbb;
      border-radius: 3px;
      padding: 0.5em 0.7em;
    }

    .overview-text { font-size: 14pt; line-height: 1.5; margin: 0; }

    /* ── Agenda ────────────────────────────────────────────────────── */
    ol.agenda { list-style: none; padding: 0; margin: 0; }
    ol.agenda li {
      display: flex;
      gap: 0.35em;
      line-height: 1.45;
      margin-bottom: 0.15em;
      font-size: 14pt;
    }
    .item-num { color: #888; min-width: 1.1em; flex-shrink: 0; }

    /* ── Todos ─────────────────────────────────────────────────────── */
    .todos-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.2em; }
    .todo-item {
      display: flex;
      align-items: flex-start;
      gap: 0.5em;
      margin-bottom: 0.35em;
      line-height: 1.4;
      font-size: 14pt;
    }
    .checkbox {
      display: inline-block;
      width: 18px;
      height: 18px;
      min-width: 18px;
      border: 2px solid #444;
      border-radius: 1px;
      margin-top: 0.15em;
      flex-shrink: 0;
    }

    /* ── Follow-ups ────────────────────────────────────────────────── */
    ul.followups { list-style: disc; padding-left: 1.2em; margin: 0; }
    ul.followups li { margin-bottom: 0.15em; font-size: 14pt; }

    /* ── Weather ───────────────────────────────────────────────────── */
    .weather-badge {
      font-size: 13pt;
      color: #555;
      background: #f2f2f2;
      border: 1px solid #ddd;
      border-radius: 3px;
      padding: 0.1em 0.5em;
    }

    /* ── Ruled lines ───────────────────────────────────────────────── */
    ruled-lines {
      display: block;
      margin-top: 0.2em;
    }
    ruled-lines hr {
      border: none;
      border-top: 1px solid #ccc;
      margin: 0 0 30px;  /* ~8mm line spacing */
    }
    /* Flex-fill variant for the dedicated notes page */
    ruled-lines.fill {
      display: flex;
      flex-direction: column;
      height: 100%;
      margin-top: 0;
      min-height: 0;
    }
    ruled-lines.fill hr {
      flex: 1 1 0;
      min-height: 0;
      margin-bottom: 0;
    }

    /* ── Notes page ────────────────────────────────────────────────── */
    .notes-page {
      break-before: page;
      height: 9.95in;
      display: flex;
      flex-direction: column;
    }
    .notes-page-title { font-size: 20pt; font-weight: 700; margin: 0 0 0.3em; }
    .notes-page-body {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .captured-notes { list-style: disc; margin: 0 0 0.5em 1.1em; padding: 0; }
    .captured-notes li { margin-bottom: 0.15em; font-size: 12.5pt; }

    /* ── Day calendar page ─────────────────────────────────────────── */
    .day-view-page {
      break-before: page;
      height: 9.95in;
      display: flex;
      flex-direction: column;
    }
    .day-view-title { font-size: 20pt; font-weight: 700; margin: 0 0 0.25em; }
    .day-view-sub { font-size: 12pt; color: #666; margin: 0 0 0.45em; }
    .calendar-shell {
      position: relative;
      border: 1px solid #bbb;
      border-radius: 3px;
      flex: 1 1 auto;
      min-height: 0;
      overflow: hidden;
      background: #fff;
    }
    .calendar-grid {
      position: absolute;
      inset: 0;
    }
    .calendar-row {
      position: absolute;
      left: 0;
      right: 0;
      display: grid;
      grid-template-columns: 72px 1fr;
      align-items: center;
    }
    .calendar-row-label {
      font-size: 10.5pt;
      color: #666;
      text-align: right;
      padding-right: 0.5em;
    }
    .calendar-row-line {
      border-top: 1px solid #e5e5e5;
      display: block;
      height: 0;
      margin-right: 0.5em;
    }
    .calendar-events {
      position: absolute;
      top: 0;
      bottom: 0;
      left: 76px;
      right: 0.5em;
    }
    .calendar-event {
      position: absolute;
      left: 0.2em;
      right: 0.2em;
      border-left: 4px solid #333;
      background: #f5f5f5;
      border-radius: 3px;
      padding: 0.18em 0.35em;
      overflow: hidden;
    }
    .calendar-event {
      font-size: 10pt;
      font-weight: 600;
      line-height: 1.2;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .calendar-event-sep { color: #999; font-weight: 400; margin: 0 0.15em; }
    .calendar-empty {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #777;
      font-size: 13pt;
    }
  </style>
</head>
<body>

  <!-- ═══ PAGE 1+ (content flows naturally) ═══ -->

  <!-- Header -->
  <div class="header-row">
    <h1 class="brief-title">Daily Brief</h1>
    <span class="weather-badge">${esc(weatherLabel(data.weather.weatherCode, data.weather.tempF))}</span>
  </div>
  <div class="date-sub">${esc(data.dateLabel)}</div>
  <hr class="divider">

  <!-- Overview -->
  <div class="panel section-gap">
    <div class="section-title">Overview</div>
    <p class="overview-text">${esc(data.overview)}</p>
  </div>

  <!-- Day Agenda -->
  <div class="panel section-gap">
    <div class="section-title">Day Agenda</div>
    <ol class="agenda">
        ${agendaHtml}
    </ol>
  </div>

  <!-- Todos -->
  ${
    activeTodos.length > 0
      ? `<div class="panel section-gap">
    <div class="section-title">Todos</div>
    <div class="todos-grid">
        ${todosHtml}
    </div>
  </div>`
      : ""
  }

  <!-- Follow-Ups -->
  ${
    data.followUps.length > 0
      ? `<div class="panel section-gap">
    <div class="section-title">Follow-Ups</div>
    <ul class="followups">
        ${followUpsHtml}
    </ul>
  </div>`
      : ""
  }



  <!-- ═══ PAGE 2: DAY CALENDAR VIEW (6AM-9PM) ═══ -->
  <div class="day-view-page">
    <div class="day-view-title">Day View</div>
    <div class="day-view-sub">6:00 AM - 9:00 PM (Pacific)</div>
    <div class="calendar-shell">
      <div class="calendar-grid">
        ${hourRows}
      </div>
      <div class="calendar-events">
        ${calendarBlocks}
      </div>
      ${calendarBlocks.length === 0 ? '<div class="calendar-empty">No calendar events for today.</div>' : ''}
    </div>
  </div>

  <!-- ═══ LAST FULL PAGE: NOTES ═══ -->
  <div class="notes-page">
    <div class="notes-page-title">Notes</div>
    <div class="notes-page-body">
      ${ruledLinesFill(28)}
    </div>
  </div>

</body>
</html>`;
}
