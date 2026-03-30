/**
 * Helper functions for preview-live.ts — extracted to reduce file complexity.
 */

import type { IngestedItem, WeatherSnapshot, NewsHeadline } from "./preview-live";
import { renderHtml, type TemplateData } from "../workers/report-worker/src/template.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const __dirname = new URL(".", import.meta.url).pathname;
const ROOT = join(__dirname, "..");

export async function renderAndSaveReport(
  data: TemplateData,
  skipPdf: boolean
): Promise<{ htmlPath: string; pdfPath?: string }> {
  const html = renderHtml(data);
  const outDir = join(ROOT, "output");
  await mkdir(outDir, { recursive: true });
  const htmlPath = join(outDir, "report-preview.html");
  await writeFile(htmlPath, html, "utf-8");
  console.log(`  HTML → ${htmlPath}`);

  if (skipPdf) {
    return { htmlPath };
  }

  console.log("⑤ Printing PDF...");
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdfBytes = await page.pdf({ format: "Letter", printBackground: true });
    const pdfPath = join(outDir, "report-preview.pdf");
    await writeFile(pdfPath, pdfBytes);
    console.log(`  PDF  → ${pdfPath}`);
    return { htmlPath, pdfPath };
  } finally {
    await browser.close();
  }
}

export function buildStructuredData(items: IngestedItem[], now: Date) {
  const { buildCalendarAgenda, detectCalendarConflicts, buildGoogleTaskTodos, buildNoteLines } = require("../workers/report-worker/src/tasks.js");
  
  const agendaEvents = buildCalendarAgenda(items, now);
  const conflicts = detectCalendarConflicts(agendaEvents);
  const todos = buildGoogleTaskTodos(items);
  const noteLines = buildNoteLines(items);

  return { agendaEvents, conflicts, todos, noteLines };
}
