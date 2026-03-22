// Daily Office lectionary data fetcher and liturgical calendar resolver.
// Combines readings from reubenlillie/daily-office with scripture text
// from bible-api.com (World English Bible, public domain).

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
    psalms: string[];
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

// ── Liturgical Calendar ──────────────────────────────────────────────

/** Compute Easter Sunday using the Anonymous Gregorian algorithm. */
function computeEaster(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function addDays(date: Date, days: number): Date {
  const r = new Date(date);
  r.setDate(r.getDate() + days);
  return r;
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function dayOfWeekName(date: Date): string {
  return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
}

function sundayOnOrBefore(date: Date): Date {
  const d = new Date(date);
  d.setDate(d.getDate() - d.getDay());
  return d;
}

/** Advent 1 = 4th Sunday before December 25. */
function computeAdvent1(year: number): Date {
  const sundayBeforeChristmas = sundayOnOrBefore(new Date(year, 11, 24));
  return addDays(sundayBeforeChristmas, -21);
}

interface LiturgicalPosition {
  yearFile: 1 | 2;
  season: string;
  week: string;
  day: string;
}

/** Resolve a civil date to its liturgical position in the daily office lectionary. */
function resolveLiturgicalPosition(date: Date): LiturgicalPosition | undefined {
  const year = date.getFullYear();
  const month = date.getMonth();
  const dom = date.getDate();

  const advent1ThisYear = computeAdvent1(year);
  const inNewAdvent = date >= advent1ThisYear;

  // The civil year containing Easter for this liturgical year
  const easterYear = inNewAdvent ? year + 1 : year;
  // Year One = Advent preceding odd years; Year Two = Advent preceding even years
  const yearFile: 1 | 2 = easterYear % 2 === 1 ? 1 : 2;

  const easter = computeEaster(easterYear);
  const ashWednesday = addDays(easter, -46);
  const advent1Current = inNewAdvent ? advent1ThisYear : computeAdvent1(year - 1);
  const advent1Next = inNewAdvent ? computeAdvent1(year + 1) : advent1ThisYear;
  const dayName = dayOfWeekName(date);

  // ── Advent (Advent 1 through Dec 24) ──
  const adventYear = inNewAdvent ? year : year - 1;
  const dec24 = new Date(adventYear, 11, 24);
  if (date >= advent1Current && date <= dec24) {
    const weeksElapsed = Math.floor(daysBetween(advent1Current, date) / 7);
    return {
      yearFile,
      season: "Advent",
      week: `Week of ${Math.min(weeksElapsed + 1, 4)} Advent`,
      day: dayName,
    };
  }

  // ── Christmas (Dec 25 – Jan 5) — not in the year files ──
  if (month === 11 && dom >= 25) return undefined;
  if (month === 0 && dom <= 5) return undefined;

  // ── Epiphany fixed dates (Jan 6–12) ──
  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (month === 0 && dom >= 6 && dom <= 12) {
    return { yearFile, season: "Epiphany", week: "Epiphany", day: `${MONTH_ABBR[month]} ${dom}` };
  }

  // ── Epiphany weeks (after Jan 12 through day before Ash Wednesday) ──
  if (date < ashWednesday) {
    const jan6 = new Date(easterYear, 0, 6);
    const week1Sun = jan6.getDay() === 0 ? addDays(jan6, 7) : addDays(jan6, 7 - jan6.getDay());

    const lastEpiphanySun = sundayOnOrBefore(addDays(ashWednesday, -1));
    if (date >= lastEpiphanySun) {
      return { yearFile, season: "Epiphany", week: "Week of Last Epiphany", day: dayName };
    }

    const weekNum = Math.floor(daysBetween(week1Sun, date) / 7) + 1;
    return { yearFile, season: "Epiphany", week: `Week of ${weekNum} Epiphany`, day: dayName };
  }

  // ── Lent (Ash Wednesday through day before Easter) ──
  if (date >= ashWednesday && date < easter) {
    const lent1Sun = addDays(ashWednesday, 4); // Next Sunday after Ash Wednesday
    if (date < lent1Sun) {
      return { yearFile, season: "Lent", week: "Ash Wednesday and Following", day: dayName };
    }
    const palmSunday = addDays(easter, -7);
    if (date >= palmSunday) {
      return { yearFile, season: "Lent", week: "Holy Week", day: dayName };
    }
    const lentWeek = Math.floor(daysBetween(lent1Sun, date) / 7) + 1;
    return { yearFile, season: "Lent", week: `Week of ${lentWeek} Lent`, day: dayName };
  }

  // ── Easter (Easter through Easter+54, including Pentecost week) ──
  const daysAfterEaster = daysBetween(easter, date);
  if (daysAfterEaster >= 0 && daysAfterEaster <= 54) {
    if (daysAfterEaster <= 6) {
      return { yearFile, season: "Easter", week: "Easter Week", day: dayName };
    }
    if (daysAfterEaster >= 49) {
      return { yearFile, season: "Easter", week: "Pentecost", day: dayName };
    }
    const easterWeek = Math.floor(daysAfterEaster / 7) + 1;
    return { yearFile, season: "Easter", week: `Week of ${easterWeek} Easter`, day: dayName };
  }

  // ── Season after Pentecost (Easter+55 through day before next Advent 1) ──
  if (date >= addDays(easter, 55) && date < advent1Next) {
    if (sameDay(date, addDays(easter, 55))) {
      return { yearFile, season: "The Season after Pentecost", week: "Eve of Trinity", day: "Saturday" };
    }
    if (sameDay(date, addDays(easter, 56))) {
      return { yearFile, season: "The Season after Pentecost", week: "Trinity Sunday", day: "Sunday" };
    }
    // Proper number based on fixed date ranges (Proper 1 = May 8–14, etc.)
    const may8 = new Date(easterYear, 4, 8);
    const properNum = Math.floor(daysBetween(may8, date) / 7) + 1;
    if (properNum >= 1 && properNum <= 29) {
      return { yearFile, season: "The Season after Pentecost", week: `Proper ${properNum}`, day: dayName };
    }
    return undefined;
  }

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

  return {
    season: entry.season,
    week: entry.week,
    day: entry.day,
    title: entry.title,
    study: mergeDeduplicatedStudy(morning, evening),
    morning,
    evening,
  };
}
