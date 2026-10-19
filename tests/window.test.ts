import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOW, sendAllowed, zonedTimeToUtc } from "@/lib/window";

const ET = "America/New_York";

function et(year: number, month: number, day: number, hour: number, minute: number): Date {
  return zonedTimeToUtc(year, month, day, hour, minute, ET);
}

describe("send window", () => {
  it("allows Thursday mid-morning ET and refuses the edges, weekend, and holidays", () => {
    expect(et(2026, 10, 22, 10, 0).toISOString()).toBe("2026-10-22T14:00:00.000Z");
    expect(sendAllowed(et(2026, 10, 22, 10, 0)).ok).toBe(true);
    expect(sendAllowed(et(2026, 10, 23, 9, 0)).ok).toBe(true);
    expect(sendAllowed(et(2026, 10, 23, 16, 59)).ok).toBe(true);

    expect(sendAllowed(et(2026, 10, 23, 8, 59)).ok).toBe(false);
    expect(sendAllowed(et(2026, 10, 23, 17, 0)).reason).toMatch(/outside ET/);
    expect(sendAllowed(et(2026, 10, 24, 11, 0)).reason).toMatch(/weekend/);
    expect(sendAllowed(et(2026, 10, 25, 11, 0)).reason).toMatch(/weekend/);

    const thanksgiving = et(2026, 11, 26, 10, 0);
    expect(sendAllowed(thanksgiving).ok).toBe(true);
    expect(sendAllowed(thanksgiving, DEFAULT_WINDOW, ["2026-11-26"]).reason).toMatch(/holiday/);
  });

  it("also requires the IST window", () => {
    const result = sendAllowed(et(2026, 10, 22, 10, 0), {
      ...DEFAULT_WINDOW,
      istStart: "00:00",
      istEnd: "00:30",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/outside IST/);
  });

  it("allows a weekday morning after US daylight time ends", () => {
    expect(sendAllowed(et(2026, 11, 2, 10, 0)).ok).toBe(true);
  });
});
