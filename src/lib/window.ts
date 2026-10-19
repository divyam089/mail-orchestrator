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
