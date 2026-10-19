import { HARD_MAX_PER_INBOX, HARD_MAX_TOTAL, clampCaps, inboxCapForDay, type RampStep } from "@/lib/caps";
import type { Db } from "@/lib/db/pool";
import { zonedTimeToUtc } from "@/lib/window";

export async function countingTowardCap(db: Db, etDate: string, inboxId?: string): Promise<number> {
  const result = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM sends_counting_toward_cap
     WHERE et_date = $1 AND ($2::uuid IS NULL OR inbox_id = $2)`,
    [etDate, inboxId ?? null],
  );
  return Number(result.rows[0]?.n ?? 0);
}

export async function prospectInboxCap(
  db: Db,
  inbox: { id: string; email: string; domain: string },
  etDate: string,
  ramp: readonly RampStep[],
  maxPerInbox: number,
): Promise<number> {
  const ceiling = clampCaps({ maxPerInbox, maxTotal: HARD_MAX_TOTAL }).maxPerInbox;
  const prior = await db.query<{ n: string }>(
    `SELECT COUNT(DISTINCT et_date)::text AS n
     FROM sends_counting_toward_cap
     WHERE inbox_id = $1 AND kind = 'prospect' AND et_date < $2`,
    [inbox.id, etDate],
  );
  const dayNumber = Number(prior.rows[0]?.n ?? 0) + 1;
  const prevDay = await db.query<{ et_date: string }>(
    `SELECT et_date::text FROM sends_counting_toward_cap
     WHERE inbox_id = $1 AND kind = 'prospect' AND et_date < $2
     ORDER BY et_date DESC
     LIMIT 1`,
    [inbox.id, etDate],
  );
  return inboxCapForDay({
    sendingDayNumber: dayNumber,
    ramp,
    maxPerInbox: ceiling,
    previousSendingDayHadStop: prevDay.rows[0] ? await hadStop(db, inbox, prevDay.rows[0].et_date) : false,
  });
}

async function hadStop(db: Db, inbox: { id: string; email: string; domain: string }, day: string): Promise<boolean> {
  const [year, month, date] = day.split("-").map(Number);
  const start = zonedTimeToUtc(year, month, date, 0, 0, "America/New_York");
  const next = new Date(Date.UTC(year, month - 1, date + 1, 12, 0, 0));
  const [ny, nm, nd] = next.toISOString().slice(0, 10).split("-").map(Number);
  const end = zonedTimeToUtc(ny, nm, nd, 0, 0, "America/New_York");
  const pauses = await db.query(
    `SELECT 1 FROM pauses
     WHERE paused_at >= $1 AND paused_at < $2
       AND (scope = 'fleet' OR target = $3 OR target = $4)
     LIMIT 1`,
    [start, end, inbox.email, inbox.domain],
  );
  if ((pauses.rowCount ?? 0) > 0) return true;
  const events = await db.query(
    `SELECT 1 FROM events
     WHERE inbox_id = $1 AND et_date = $2 AND kind IN ('hard_bounce', 'complaint', 'provider_error')
     LIMIT 1`,
    [inbox.id, day],
  );
  return (events.rowCount ?? 0) > 0;
}

export function fleetCeiling(maxTotal: number): number {
  return Math.min(clampCaps({ maxPerInbox: HARD_MAX_PER_INBOX, maxTotal }).maxTotal, HARD_MAX_TOTAL);
}
