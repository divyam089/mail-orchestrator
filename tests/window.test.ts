import { describe, expect, it } from "vitest";
import { addBusinessDays, DEFAULT_WINDOW, leadWindowAllows, sendAllowed, zonedTimeToUtc } from "@/lib/window";

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

  it("adds business days and skips weekends and listed holidays", () => {
    expect(addBusinessDays("2026-10-22", 3)).toBe("2026-10-27");
    expect(addBusinessDays("2026-10-22", 1, ["2026-10-23"])).toBe("2026-10-26");
    expect(addBusinessDays("2026-10-22", 0)).toBe("2026-10-22");
  });

  it("intersects the lead's local hours with the ET window", () => {
    const morning = et(2026, 10, 22, 10, 0);
    expect(leadWindowAllows(morning, "America/New_York").ok).toBe(true);
    expect(leadWindowAllows(morning, null).ok).toBe(true);
    expect(leadWindowAllows(morning, "America/Los_Angeles").reason).toMatch(/Los_Angeles/);
    expect(leadWindowAllows(et(2026, 10, 22, 12, 0), "America/Los_Angeles").ok).toBe(true);
    expect(leadWindowAllows(morning, "Asia/Kolkata").reason).toMatch(/Kolkata/);
    expect(leadWindowAllows(et(2026, 10, 24, 12, 0), "America/Los_Angeles").reason).toMatch(/weekend/);
    expect(leadWindowAllows(et(2026, 11, 2, 10, 0), "America/New_York").ok).toBe(true);
    expect(leadWindowAllows(et(2026, 10, 22, 17, 0), "America/New_York").ok).toBe(false);
  });
});
