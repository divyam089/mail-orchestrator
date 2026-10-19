/**
 * Send window from the tested sender: US Eastern 09:00–17:00, Monday–Friday,
 * and inside 18:30–06:30 IST. Both must hold. The end minute is exclusive.
 * US holidays are skipped only when the caller lists them.
 */

const ET = "America/New_York";
const IST = "Asia/Kolkata";
const WEEKEND = new Set(["Sat", "Sun"]);

export type SendWindow = {
  etStart: string;
  etEnd: string;
  istStart: string;
  istEnd: string;
};

export const DEFAULT_WINDOW: SendWindow = {
  etStart: "09:00",
  etEnd: "17:00",
  istStart: "18:30",
  istEnd: "06:30",
};

type Zoned = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: string;
};

function zonedParts(date: Date, timeZone: string): Zoned {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    weekday: bag.weekday,
  };
}

function isoDate(parts: Zoned): string {
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return `${parts.year}-${month}-${day}`;
}

/** Wall time in `timeZone` as a UTC Date. Used by tests and the later planner. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const want = utc;
  for (let i = 0; i < 4; i++) {
    const parts = zonedParts(new Date(utc), timeZone);
    const got = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const diff = want - got;
    if (diff === 0) return new Date(utc);
    utc += diff;
  }
  return new Date(utc);
}

function minutes(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

function inWindow(nowMin: number, start: number, end: number): boolean {
  if (start === end) return false;
  if (start < end) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end;
}

export function sendAllowed(
  at: Date,
  window: SendWindow = DEFAULT_WINDOW,
  holidays: readonly string[] = [],
): { ok: boolean; reason: string } {
  const et = zonedParts(at, ET);
  const etDate = isoDate(et);
  if (WEEKEND.has(et.weekday) || holidays.includes(etDate)) {
    return { ok: false, reason: `US weekend or holiday (${et.weekday} ${etDate} ET)` };
  }
  if (!inWindow(et.hour * 60 + et.minute, minutes(window.etStart), minutes(window.etEnd))) {
    return { ok: false, reason: `outside ET ${window.etStart}-${window.etEnd}` };
  }
  const ist = zonedParts(at, IST);
  if (!inWindow(ist.hour * 60 + ist.minute, minutes(window.istStart), minutes(window.istEnd))) {
    return { ok: false, reason: `outside IST ${window.istStart}-${window.istEnd}` };
  }
  return { ok: true, reason: "ok" };
}

export function etDateISO(at: Date): string {
  return isoDate(zonedParts(at, ET));
}

/** UTC instants of the ET clock window on one Eastern calendar date. End is exclusive. */
export function etWindowBounds(etDate: string, window: SendWindow = DEFAULT_WINDOW): { start: Date; end: Date } {
  const [year, month, day] = etDate.split("-").map(Number);
  const [startHour, startMinute] = window.etStart.split(":").map(Number);
  const [endHour, endMinute] = window.etEnd.split(":").map(Number);
  return {
    start: zonedTimeToUtc(year, month, day, startHour, startMinute, ET),
    end: zonedTimeToUtc(year, month, day, endHour, endMinute, ET),
  };
}

export function isUsBusinessDay(etDate: string, holidays: readonly string[] = []): boolean {
  const [year, month, day] = etDate.split("-").map(Number);
  const noon = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const weekday = noon.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !holidays.includes(etDate);
}

/** Move forward `days` US business days. Weekends and listed holidays do not count. */
export function addBusinessDays(etDate: string, days: number, holidays: readonly string[] = []): string {
  if (!Number.isInteger(days) || days < 0) throw new Error("days must be an integer >= 0");
  const [year, month, day] = etDate.split("-").map(Number);
  let cursor = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  let left = days;
  while (left > 0) {
    cursor = new Date(cursor.getTime() + 86_400_000);
    const iso = cursor.toISOString().slice(0, 10);
    if (!isUsBusinessDay(iso, holidays)) continue;
    left -= 1;
  }
  return cursor.toISOString().slice(0, 10);
}

const LEAD_START = 9 * 60;
const LEAD_END = 17 * 60;

/**
 * The lead's local 09:00–17:00 intersected with the US weekday ET/IST window.
 * A missing timezone is treated as America/New_York. The end minute is exclusive.
 */
export function leadWindowAllows(
  at: Date,
  leadTimezone: string | null | undefined,
  window: SendWindow = DEFAULT_WINDOW,
  holidays: readonly string[] = [],
): { ok: boolean; reason: string } {
  const base = sendAllowed(at, window, holidays);
  if (!base.ok) return base;
  const zone = leadTimezone?.trim() || ET;
  let local: Zoned;
  try {
    local = zonedParts(at, zone);
  } catch {
    return { ok: false, reason: `invalid lead timezone ${zone}` };
  }
  if (!inWindow(local.hour * 60 + local.minute, LEAD_START, LEAD_END)) {
    return { ok: false, reason: `outside lead local 09:00-17:00 (${zone})` };
  }
  return { ok: true, reason: "ok" };
}
