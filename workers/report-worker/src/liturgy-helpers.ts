/**
 * Liturgical position helpers extracted from daily-office.ts
 */

interface LiturgicalPosition {
  yearFile: 1 | 2;
  season: string;
  week: string;
  day: string;
}

interface LiturgicalContext {
  yearFile: 1 | 2;
  dayName: string;
  easter: Date;
  ashWednesday: Date;
  advent1Current: Date;
  advent1Next: Date;
  easterYear: number;
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

export function computeAdvent1(year: number): Date {
  const sundayBeforeChristmas = sundayOnOrBefore(new Date(year, 11, 24));
  return addDays(sundayBeforeChristmas, -21);
}

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

export function buildLiturgicalContext(date: Date, year: number, inNewAdvent: boolean): LiturgicalContext {
  const easterYear = inNewAdvent ? year + 1 : year;
  const yearFile: 1 | 2 = easterYear % 2 === 1 ? 1 : 2;
  const easter = computeEaster(easterYear);
  const ashWednesday = addDays(easter, -46);
  const advent1Current = inNewAdvent ? computeAdvent1(year) : computeAdvent1(year - 1);
  const advent1Next = inNewAdvent ? computeAdvent1(year + 1) : computeAdvent1(year);
  const dayName = dayOfWeekName(date);

  return { yearFile, dayName, easter, ashWednesday, advent1Current, advent1Next, easterYear };
}

export function checkAdvent(date: Date, context: LiturgicalContext, advent1ThisYear: Date): LiturgicalPosition | undefined {
  // Advent starts and ends in the same calendar year — use advent1Current's year,
  // NOT easterYear (which is the following year for dates after Advent 1).
  const dec24 = new Date(context.advent1Current.getFullYear(), 11, 24);
  if (date >= context.advent1Current && date <= dec24) {
    const weeksElapsed = Math.floor(daysBetween(context.advent1Current, date) / 7);
    return {
      yearFile: context.yearFile,
      season: "Advent",
      week: `Week of ${Math.min(weeksElapsed + 1, 4)} Advent`,
      day: context.dayName,
    };
  }
  return undefined;
}

export function checkChristmas(month: number, dom: number, context: LiturgicalContext): LiturgicalPosition | undefined {
  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // Dec 25–31 or Jan 1–5
  if ((month === 11 && dom >= 25) || (month === 0 && dom <= 5)) {
    return {
      yearFile: context.yearFile,
      season: "Christmas",
      week: "Christmas Day and Following",
      day: `${MONTH_ABBR[month]} ${dom}`,
    };
  }
  return undefined;
}

export function checkEpiphanyFixed(month: number, dom: number, context: LiturgicalContext): LiturgicalPosition | undefined {
  const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (month === 0 && dom >= 6 && dom <= 12) {
    return { yearFile: context.yearFile, season: "Epiphany", week: "The Epiphany and Following", day: `${MONTH_ABBR[month]} ${dom}` };
  }
  return undefined;
}

export function checkEpiphanyWeeks(date: Date, context: LiturgicalContext): LiturgicalPosition | undefined {
  if (date >= context.ashWednesday) return undefined;

  const jan6 = new Date(context.easterYear, 0, 6);
  const week1Sun = jan6.getDay() === 0 ? addDays(jan6, 7) : addDays(jan6, 7 - jan6.getDay());
  const lastEpiphanySun = sundayOnOrBefore(addDays(context.ashWednesday, -1));

  if (date >= lastEpiphanySun) {
    return { yearFile: context.yearFile, season: "Epiphany", week: "Week of Last Epiphany", day: context.dayName };
  }

  const weekNum = Math.floor(daysBetween(week1Sun, date) / 7) + 1;
  return { yearFile: context.yearFile, season: "Epiphany", week: `Week of ${weekNum} Epiphany`, day: context.dayName };
}

export function checkLent(date: Date, context: LiturgicalContext): LiturgicalPosition | undefined {
  if (date < context.ashWednesday || date >= context.easter) return undefined;

  const lent1Sun = addDays(context.ashWednesday, 4);
  if (date < lent1Sun) {
    return { yearFile: context.yearFile, season: "Lent", week: "Ash Wednesday and Following", day: context.dayName };
  }

  const palmSunday = addDays(context.easter, -7);
  if (date >= palmSunday) {
    return { yearFile: context.yearFile, season: "Lent", week: "Holy Week", day: context.dayName };
  }

  const lentWeek = Math.floor(daysBetween(lent1Sun, date) / 7) + 1;
  return { yearFile: context.yearFile, season: "Lent", week: `Week of ${lentWeek} Lent`, day: context.dayName };
}

export function checkEaster(date: Date, context: LiturgicalContext): LiturgicalPosition | undefined {
  const daysAfterEaster = daysBetween(context.easter, date);
  if (daysAfterEaster < 0 || daysAfterEaster > 54) return undefined;

  if (daysAfterEaster <= 6) {
    return { yearFile: context.yearFile, season: "Easter", week: "Easter Week", day: context.dayName };
  }
  if (daysAfterEaster >= 49) {
    return { yearFile: context.yearFile, season: "Easter", week: "Pentecost", day: context.dayName };
  }

  const easterWeek = Math.floor(daysAfterEaster / 7) + 1;
  return { yearFile: context.yearFile, season: "Easter", week: `Week of ${easterWeek} Easter`, day: context.dayName };
}

export function checkAfterPentecost(date: Date, context: LiturgicalContext): LiturgicalPosition | undefined {
  if (date < addDays(context.easter, 55) || date >= context.advent1Next) return undefined;

  if (sameDay(date, addDays(context.easter, 55))) {
    return { yearFile: context.yearFile, season: "The Season after Pentecost", week: "Eve of Trinity", day: "Saturday" };
  }
  if (sameDay(date, addDays(context.easter, 56))) {
    return { yearFile: context.yearFile, season: "The Season after Pentecost", week: "Trinity Sunday", day: "Sunday" };
  }

  const may8 = new Date(context.easterYear, 4, 8);
  const properNum = Math.floor(daysBetween(may8, date) / 7) + 1;
  if (properNum >= 1 && properNum <= 29) {
    return { yearFile: context.yearFile, season: "The Season after Pentecost", week: `Proper ${properNum}`, day: context.dayName };
  }

  return undefined;
}

export { LiturgicalPosition };
