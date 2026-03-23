/**
 * Local PDF preview script.
 *
 * Loads a fixture JSON, renders the HTML template, then uses Puppeteer to
 * print it to a PDF — no Cloudflare account or reMarkable device required.
 *
 * Usage:
 *   npm run preview
 *
 * Output:
 *   output/report-preview.pdf   (open this to check layout)
 *   output/report-preview.html  (open in browser for live CSS tweaking)
 */

import puppeteer from "puppeteer";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { renderHtml, type TemplateData } from "../workers/report-worker/src/template.js";

interface Fixture {
  dateLabel: string;
  weather: { highF: number; lowF: number; weatherCode: number; hourly: Array<{ hour: number; tempF: number; weatherCode: number }> };
  report: {
    overview: string;
    deltaSinceYesterday: string;
    agendaEvents: Array<{
      title: string;
      startAt: string;
      endAt: string;
      startLabel: string;
      endLabel: string;
      calendarName: string;
    }>;
    todos: Array<{ task: string; done: boolean; isSubtask?: boolean }>;
    noteLines: string[];
  };
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = join(__dirname, "..");

async function main(): Promise<void> {
  const fixturePath = join(__dirname, "fixtures", "report-sample.json");
  const raw = await readFile(fixturePath, "utf-8");
  const fixture: Fixture = JSON.parse(raw);

  const data: TemplateData = {
    dateLabel: fixture.dateLabel,
    weather: fixture.weather,
    overview: fixture.report.overview,
    deltaSinceYesterday: fixture.report.deltaSinceYesterday,
    agendaEvents: fixture.report.agendaEvents,
    todos: fixture.report.todos,
    noteLines: fixture.report.noteLines,
  };

  const html = renderHtml(data);

  const outDir = join(root, "output");
  await mkdir(outDir, { recursive: true });

  const htmlPath = join(outDir, "report-preview.html");
  await writeFile(htmlPath, html, "utf-8");

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();

    // waitUntil: "networkidle0" ensures Bootstrap CSS loads from CDN before print.
    await page.setContent(html, { waitUntil: "networkidle0" });

    const pdfBytes = await page.pdf({
      format: "Letter",
      printBackground: true,
      // Margins are set in @page CSS; do not duplicate them here.
    });

    const pdfPath = join(outDir, "report-preview.pdf");
    await writeFile(pdfPath, pdfBytes);

    console.log("Done.");
    console.log(`  PDF  → ${pdfPath}`);
    console.log(`  HTML → ${htmlPath}`);
  } finally {
    await browser.close();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
