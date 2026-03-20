// HTML report template.
// Used by scripts/preview-report.ts (local Puppeteer) and, in Phase 2,
// by the Cloudflare Worker via @cloudflare/puppeteer (Browser Rendering).

export interface TemplateData {
  dateLabel: string;
  weather: { tempF: number; weatherCode: number };
  overview: string;
  agenda: string[];
  todos: Array<{ task: string; done: boolean }>;
  followUps: string[];
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
  // Phase 1: Filter out done items — they'll drop off the next day's report.
  const activeTodos = data.todos.filter((t) => !t.done);

  const agendaHtml = data.agenda
    .map(
      (item, i) =>
        `<li><span class="item-num">${i + 1}.</span>${esc(item)}</li>`
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
    .todos-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 1.5em; }
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

  <!-- Inline notes (fixed block, ~8 lines) -->
  <div class="section-gap" style="margin-top:0.4em">
    <div class="section-title">Notes</div>
    ${ruledLines(8)}
  </div>

  <!-- ═══ DEDICATED NOTES PAGE (always present) ═══ -->
  <div class="notes-page">
    <div class="notes-page-title">Notes</div>
    <div class="notes-page-body">
      ${ruledLinesFill(28)}
    </div>
  </div>

</body>
</html>`;
}
