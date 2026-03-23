// Daily Office lectionary data fetcher and liturgical calendar resolver.
// Combines readings from reubenlillie/daily-office with scripture text
// from bible-api.com (World English Bible, public domain).

import {
  buildLiturgicalContext,
  checkAdvent,
  checkChristmas,
  checkEpiphanyFixed,
  checkEpiphanyWeeks,
  checkLent,
  checkEaster,
  checkAfterPentecost,
  computeAdvent1,
  type LiturgicalPosition,
} from "./liturgy-helpers.js";

export interface DailyOfficeLesson {
  reference: string;
  text?: string;
}

export interface DailyOfficeSection {
  psalms: string[];
  first?: DailyOfficeLesson;
  second?: DailyOfficeLesson;
  gospel?: DailyOfficeLesson;
}

export interface DailyOfficeData {
  season: string;
  week: string;
  day: string;
  title?: string;
  study: {
    psalms: DailyOfficeLesson[];
    lessons: DailyOfficeLesson[];
  };
  morning: DailyOfficeSection;
  evening: DailyOfficeSection;
}

function normalizeLessonReference(reference: string): string {
  return reference
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function mergeDeduplicatedStudy(morning: DailyOfficeSection, evening: DailyOfficeSection): { psalms: string[]; lessons: DailyOfficeLesson[] } {
  const psalmSeen = new Set<string>();
  const psalms: string[] = [];
  for (const psalm of [...morning.psalms, ...evening.psalms]) {
    const key = psalm.trim();
    if (!key || psalmSeen.has(key)) continue;
    psalmSeen.add(key);
    psalms.push(key);
  }

  const lessons: DailyOfficeLesson[] = [];
  const lessonSeen = new Set<string>();
  const orderedLessons = [
    morning.first,
    morning.second,
    morning.gospel,
    evening.first,
    evening.second,
    evening.gospel,
  ];

  for (const lesson of orderedLessons) {
    if (!lesson?.reference) continue;
    const key = normalizeLessonReference(lesson.reference);
    if (lessonSeen.has(key)) continue;
    lessonSeen.add(key);
    lessons.push(lesson);
  }

  return { psalms, lessons };
}

// Liturgical position and calendar functions are in ./liturgy-helpers.ts

/** Resolve a civil date to its liturgical position in the daily office lectionary. */
function resolveLiturgicalPosition(date: Date): LiturgicalPosition | undefined {
  const year = date.getFullYear();
  const month = date.getMonth();
  const dom = date.getDate();

  const advent1ThisYear = computeAdvent1(year);
  const inNewAdvent = date >= advent1ThisYear;
  const context = buildLiturgicalContext(date, year, inNewAdvent);

  // Try each liturgical season in order
  let result = checkAdvent(date, context, advent1ThisYear);
  if (result !== undefined) return result;

  result = checkChristmas(month, dom);
  if (result !== undefined) return result;

  result = checkEpiphanyFixed(month, dom, context);
  if (result !== undefined) return result;

  result = checkEpiphanyWeeks(date, context);
  if (result !== undefined) return result;

  result = checkLent(date, context);
  if (result !== undefined) return result;

  result = checkEaster(date, context);
  if (result !== undefined) return result;

  result = checkAfterPentecost(date, context);
  if (result !== undefined) return result;

  return undefined;
}

// ── JSON Data Types (from reubenlillie/daily-office) ─────────────────

interface LessonEntry {
  first?: string;
  second?: string;
  gospel?: string;
  morning?: { first?: string; second?: string; gospel?: string };
  evening?: { first?: string; second?: string; gospel?: string };
}

interface ReadingEntry {
  year: string;
  season: string;
  week: string;
  day: string;
  title?: string;
  psalms: { morning: string[]; evening: string[] };
  lessons: LessonEntry;
}

// ── Lectionary JSON Fetching & Caching ──────────────────────────────

const YEAR_FILE_URLS: Record<1 | 2, string> = {
  1: "https://raw.githubusercontent.com/reubenlillie/daily-office/master/json/readings/dol-year-1.json",
  2: "https://raw.githubusercontent.com/reubenlillie/daily-office/master/json/readings/dol-year-2.json",
};

async function fetchLectionaryData(kv: KVNamespace, yearFile: 1 | 2): Promise<ReadingEntry[]> {
  const cacheKey = `daily-office:year-${yearFile}`;
  const cached = await kv.get(cacheKey);
  if (cached) return JSON.parse(cached) as ReadingEntry[];

  const res = await fetch(YEAR_FILE_URLS[yearFile]);
  if (!res.ok) throw new Error(`Failed to fetch lectionary year ${yearFile}: ${res.status}`);
  const text = await res.text();
  await kv.put(cacheKey, text, { expirationTtl: 30 * 24 * 60 * 60 });
  return JSON.parse(text) as ReadingEntry[];
}

function findEntry(data: ReadingEntry[], pos: LiturgicalPosition): ReadingEntry | undefined {
  return data.find(
    (e) => e.season === pos.season && e.week === pos.week && e.day === pos.day
  );
}

// ── Scripture Text Fetching (bible-api.com, WEB translation) ────────

function cleanReference(ref: string): string {
  // Normalize en-dashes/em-dashes to hyphens (lectionary JSON uses en-dashes)
  // and strip parenthetical optional sections: "Gen 1:1-10 (11-20)" → "Gen 1:1-10"
  return ref.replace(/[\u2013\u2014]/g, "-").replace(/\s*\(.*?\)\s*/g, "").trim();
}

async function fetchScriptureText(kv: KVNamespace, reference: string): Promise<string | undefined> {
  const cleaned = cleanReference(reference);
  if (!cleaned) return undefined;

  const cacheKey = `scripture:${cleaned}`;
  const cached = await kv.get(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://bible-api.com/${encodeURIComponent(cleaned)}?translation=web`;
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const body = (await res.json()) as { text?: string; error?: string };
    if (body.error || !body.text) return undefined;
    const text = body.text.trim();
    await kv.put(cacheKey, text, { expirationTtl: 24 * 60 * 60 });
    return text;
  } catch {
    return undefined;
  }
}

// ── Build Sections ──────────────────────────────────────────────────

async function buildSection(
  kv: KVNamespace,
  psalms: string[],
  lessons: { first?: string; second?: string; gospel?: string }
): Promise<DailyOfficeSection> {
  const [firstText, secondText, gospelText] = await Promise.all([
    lessons.first ? fetchScriptureText(kv, lessons.first) : Promise.resolve(undefined),
    lessons.second ? fetchScriptureText(kv, lessons.second) : Promise.resolve(undefined),
    lessons.gospel ? fetchScriptureText(kv, lessons.gospel) : Promise.resolve(undefined),
  ]);

  return {
    psalms,
    first: lessons.first ? { reference: lessons.first, text: firstText } : undefined,
    second: lessons.second ? { reference: lessons.second, text: secondText } : undefined,
    gospel: lessons.gospel ? { reference: lessons.gospel, text: gospelText } : undefined,
  };
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Fetch the Daily Office readings for a given date.
 * @param kv  KV namespace for caching lectionary data and scripture text
 * @param date  Civil date (local time, not UTC) — construct from Pacific time parts
 * @returns Readings with scripture text, or undefined if no entry found
 */
export async function fetchDailyOffice(
  kv: KVNamespace,
  date: Date
): Promise<DailyOfficeData | undefined> {
  const pos = resolveLiturgicalPosition(date);
  if (!pos) return undefined;

  const entries = await fetchLectionaryData(kv, pos.yearFile);
  const entry = findEntry(entries, pos);
  if (!entry) return undefined;

  // Some entries have separate morning/evening lessons (e.g., Palm Sunday, Pentecost Eve)
  const morningLessons = entry.lessons.morning ?? {
    first: entry.lessons.first,
    second: entry.lessons.second,
    gospel: entry.lessons.gospel,
  };
  const eveningLessons = entry.lessons.evening ?? {
    first: entry.lessons.first,
    second: entry.lessons.second,
    gospel: entry.lessons.gospel,
  };

  const [morning, evening] = await Promise.all([
    buildSection(kv, entry.psalms.morning, morningLessons),
    buildSection(kv, entry.psalms.evening, eveningLessons),
  ]);

  const merged = mergeDeduplicatedStudy(morning, evening);

  // Fetch psalm text in parallel
  const psalmLessons: DailyOfficeLesson[] = await Promise.all(
    merged.psalms.map(async (num) => {
      const reference = `Psalm ${num}`;
      const text = await fetchScriptureText(kv, reference);
      return { reference, text };
    })
  );

  return {
    season: entry.season,
    week: entry.week,
    day: entry.day,
    title: entry.title,
    study: { psalms: psalmLessons, lessons: merged.lessons },
    morning,
    evening,
  };
}
