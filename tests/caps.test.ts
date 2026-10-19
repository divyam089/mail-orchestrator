import { describe, expect, it } from "vitest";
import {
  DEFAULT_RAMP,
  HARD_MAX_PER_INBOX,
  HARD_MAX_TOTAL,
  clampCaps,
  inboxCapForDay,
  rampValue,
} from "@/lib/caps";

describe("caps", () => {
  it("hard-limits config that tries to raise the caps", () => {
    expect(HARD_MAX_PER_INBOX).toBe(27);
    expect(HARD_MAX_TOTAL).toBe(405);
    expect(clampCaps({ maxPerInbox: 40, maxTotal: 600 })).toEqual({
      maxPerInbox: 27,
      maxTotal: 405,
    });
    expect(clampCaps({ maxPerInbox: 10, maxTotal: 100 })).toEqual({
      maxPerInbox: 10,
      maxTotal: 100,
    });
  });

  it("ramps 9, then 18, then 27, and a raised ramp entry is cut to 27", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9].map((day) => rampValue(day))).toEqual([
      9, 9, 9, 18, 18, 18, 18, 27, 27,
    ]);
    expect(rampValue(1, [{ days: null, perInbox: 50 }])).toBe(27);
  });

  it("matches the fleet totals 135, 270, 405 and holds a step-up after a stop", () => {
    const totals = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (day) =>
        inboxCapForDay({
          sendingDayNumber: day,
          ramp: DEFAULT_RAMP,
          maxPerInbox: 27,
          previousSendingDayHadStop: false,
        }) * 15,
    );
    expect(totals).toEqual([135, 135, 135, 270, 270, 270, 270, 405, 405]);

    expect(
      inboxCapForDay({
        sendingDayNumber: 4,
        maxPerInbox: 27,
        previousSendingDayHadStop: true,
      }),
    ).toBe(9);
    expect(
      inboxCapForDay({
        sendingDayNumber: 8,
        maxPerInbox: 27,
        previousSendingDayHadStop: true,
      }),
    ).toBe(18);
    expect(
      inboxCapForDay({
        sendingDayNumber: 5,
        maxPerInbox: 27,
        previousSendingDayHadStop: true,
      }),
    ).toBe(18);
    expect(
      inboxCapForDay({
        sendingDayNumber: 8,
        maxPerInbox: 10,
        previousSendingDayHadStop: false,
      }),
    ).toBe(10);
  });
});
