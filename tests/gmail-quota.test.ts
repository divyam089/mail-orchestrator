import { describe, expect, it } from "vitest";
import {
  GMAIL_LIST_MAX_RESULTS,
  GMAIL_PAGE_SIZE,
  GMAIL_QUOTA,
  GMAIL_SCOPES,
  GMAIL_SYNC_LIMIT_MAX,
  assertSyncLimit,
} from "@/lib/mail/quota";

describe("gmail quota", () => {
  it("matches the Gmail usage-limit table checked on 2026-10-19", () => {
    expect(GMAIL_QUOTA.perProjectPerMinute).toBe(1_200_000);
    expect(GMAIL_QUOTA.perUserPerMinute).toBe(6_000);
    expect(GMAIL_QUOTA.getProfile).toBe(1);
    expect(GMAIL_QUOTA.historyList).toBe(2);
    expect(GMAIL_QUOTA.messagesList).toBe(5);
    expect(GMAIL_QUOTA.messagesGet).toBe(20);
    expect(GMAIL_QUOTA.messagesGetFull).toBe(60);
    expect(GMAIL_QUOTA.messagesSend).toBe(100);
    expect(GMAIL_LIST_MAX_RESULTS).toBe(500);
    expect(GMAIL_PAGE_SIZE).toBeLessThanOrEqual(50);
    expect(GMAIL_PAGE_SIZE).toBeLessThanOrEqual(GMAIL_LIST_MAX_RESULTS);
    expect(GMAIL_SYNC_LIMIT_MAX * GMAIL_QUOTA.messagesGetFull).toBeLessThan(GMAIL_QUOTA.perUserPerMinute);
    expect(GMAIL_SCOPES).toEqual([
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.modify",
    ]);
  });

  it("rejects a sync limit outside 1..50", () => {
    expect(() => assertSyncLimit(50)).not.toThrow();
    expect(() => assertSyncLimit(1)).not.toThrow();
    expect(() => assertSyncLimit(0)).toThrow(/1 to 50/);
    expect(() => assertSyncLimit(51)).toThrow(/1 to 50/);
    expect(() => assertSyncLimit(1.5)).toThrow(/1 to 50/);
  });
});
