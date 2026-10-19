/** divyam 17 Oct 2026: code never goes above these. Config may lower them. */
export const HARD_MAX_PER_INBOX = 27;
export const HARD_MAX_TOTAL = 405;

export type RampStep = { days: number | null; perInbox: number };

/** First 3 sending days at 9, next 4 at 18, then 27. */
export const DEFAULT_RAMP: RampStep[] = [
  { days: 3, perInbox: 9 },
  { days: 4, perInbox: 18 },
  { days: null, perInbox: 27 },
];

export function clampCaps(input: { maxPerInbox: number; maxTotal: number }): {
  maxPerInbox: number;
  maxTotal: number;
} {
  return {
    maxPerInbox: Math.min(input.maxPerInbox, HARD_MAX_PER_INBOX),
    maxTotal: Math.min(input.maxTotal, HARD_MAX_TOTAL),
  };
}

/**
 * dayNumber is the 1-based count of this inbox's sending days, including today.
 * A ramp entry of `{ days: null }` runs forever. Values above the hard cap are cut.
 */
export function rampValue(dayNumber: number, ramp: readonly RampStep[] = DEFAULT_RAMP): number {
  if (!Number.isInteger(dayNumber) || dayNumber < 1) {
    throw new Error("dayNumber must be an integer >= 1");
  }
  if (ramp.length === 0) return HARD_MAX_PER_INBOX;
  let left = dayNumber;
  for (const step of ramp) {
    const per = Math.min(step.perInbox, HARD_MAX_PER_INBOX);
    if (step.days == null || left <= step.days) return per;
    left -= step.days;
  }
  return Math.min(ramp[ramp.length - 1].perInbox, HARD_MAX_PER_INBOX);
}

/**
 * Per-inbox cap for one US Eastern day. A step-up is held at the previous level
 * when the previous sending day had a stop event (bounce, complaint, pause).
 */
export function inboxCapForDay(args: {
  sendingDayNumber: number;
  ramp?: readonly RampStep[];
  maxPerInbox: number;
  previousSendingDayHadStop: boolean;
}): number {
  const ramp = args.ramp ?? DEFAULT_RAMP;
  const ceiling = clampCaps({ maxPerInbox: args.maxPerInbox, maxTotal: HARD_MAX_TOTAL }).maxPerInbox;
  const level = rampValue(args.sendingDayNumber, ramp);
  let held = level;
  if (args.sendingDayNumber > 1 && args.previousSendingDayHadStop) {
    const previous = rampValue(args.sendingDayNumber - 1, ramp);
    if (level > previous) held = previous;
  }
  return Math.min(held, ceiling, HARD_MAX_PER_INBOX);
}
