import { describe, expect, it } from "vitest";
import { GmailApiError, GmailReadOnlyViolation, backoffDelayMs, shouldRetryGmail } from "@/lib/mail/backoff";
import { createGmailReadClient, gmailGet, type GmailFetch } from "@/lib/mail/gmail-rest";
import { assertGmailReadOnly } from "@/lib/mail/readonly";

type Scripted = { status: number; reason?: string; retryAfter?: string; ok?: boolean };

function scriptedFetch(steps: Scripted[]): { fetchImpl: GmailFetch; urls: string[]; methods: string[] } {
  const urls: string[] = [];
  const methods: string[] = [];
  let index = 0;
  const fetchImpl: GmailFetch = async (url, init) => {
    urls.push(url);
    methods.push(init.method);
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    const body = step.ok
      ? { emailAddress: "divyam@usefigcel.com", historyId: "9", messages: [], history: [] }
      : { error: { message: "nope", errors: [{ reason: step.reason ?? "backendError" }] } };
    return {
      status: step.status,
      headers: { get: (name) => (name.toLowerCase() === "retry-after" ? (step.retryAfter ?? null) : null) },
      text: async () => JSON.stringify(body),
    };
  };
  return { fetchImpl, urls, methods };
}

describe("gmail backoff", () => {
  it("waits 1s then 2s on two 429s when jitter is zero", async () => {
    const delays: number[] = [];
    const { fetchImpl } = scriptedFetch([
      { status: 429, reason: "rateLimitExceeded" },
      { status: 429, reason: "userRateLimitExceeded" },
      { status: 200, ok: true },
    ]);
    const result = await gmailGet({
      path: "/gmail/v1/users/me/profile",
      getToken: async () => "token",
      fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      randomMs: () => 0,
    });
    expect(result.status).toBe(200);
    expect(delays).toEqual([1000, 2000]);
    expect(backoffDelayMs(0, 0)).toBe(1000);
    expect(backoffDelayMs(1, 0)).toBe(2000);
  });

  it("honors Retry-After and does not retry domainPolicy", async () => {
    const delays: number[] = [];
    const rate = scriptedFetch([{ status: 429, retryAfter: "3" }, { status: 200, ok: true }]);
    await gmailGet({
      path: "/gmail/v1/users/me/profile",
      getToken: async () => "token",
      fetchImpl: rate.fetchImpl,
      sleep: async (ms) => {
        delays.push(ms);
      },
      randomMs: () => 0,
    });
    expect(delays).toEqual([3000]);

    const blocked = scriptedFetch([{ status: 403, reason: "domainPolicy" }]);
    await expect(
      gmailGet({
        path: "/gmail/v1/users/me/profile",
        getToken: async () => "token",
        fetchImpl: blocked.fetchImpl,
        sleep: async () => {
          throw new Error("domainPolicy must not sleep");
        },
        randomMs: () => 0,
      }),
    ).rejects.toBeInstanceOf(GmailApiError);
    expect(blocked.urls).toHaveLength(1);
    expect(shouldRetryGmail(403, "domainPolicy")).toBe(false);
    expect(shouldRetryGmail(403, "dailyLimitExceeded")).toBe(false);
    expect(shouldRetryGmail(404, null)).toBe(false);
    expect(shouldRetryGmail(403, "rateLimitExceeded")).toBe(true);
    expect(shouldRetryGmail(503, "backendError")).toBe(true);
  });

  it("stops after five 503 responses", async () => {
    const delays: number[] = [];
    const { fetchImpl, urls } = scriptedFetch([
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
      { status: 503 },
    ]);
    await expect(
      gmailGet({
        path: "/gmail/v1/users/me/profile",
        getToken: async () => "token",
        fetchImpl,
        sleep: async (ms) => {
          delays.push(ms);
        },
        randomMs: () => 0,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(urls).toHaveLength(5);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
  });

  it("treats history 404 as expiry and does not request historyTypes", async () => {
    const { fetchImpl, urls, methods } = scriptedFetch([{ status: 404, reason: "notFound" }]);
    const client = createGmailReadClient({
      getToken: async () => "token",
      fetchImpl,
      sleep: async () => {
        throw new Error("404 must not retry");
      },
      randomMs: () => 0,
    });
    await expect(client.listHistory({ startHistoryId: "15", maxResults: 50 })).resolves.toEqual({ expired: true });
    expect(urls).toHaveLength(1);
    expect(methods).toEqual(["GET"]);
    expect(urls[0]).toContain("/gmail/v1/users/me/history?");
    expect(urls[0]).toContain("startHistoryId=15");
    expect(urls[0]).toContain("maxResults=50");
    expect(urls[0]).not.toContain("historyTypes");
    await expect(client.getMessage("missing", "full")).resolves.toBeNull();
  });
});

describe("gmail read-only allowlist", () => {
  it("rejects send, labels, attachments, and non-GET before any fetch", async () => {
    const fetchImpl: GmailFetch = async () => {
      throw new Error("fetch must not run");
    };
    const blocked = [
      "/gmail/v1/users/me/messages/send",
      "/gmail/v1/users/me/messages/batchModify",
      "/gmail/v1/users/me/messages/trash",
      "/gmail/v1/users/me/labels",
      "/gmail/v1/users/me/drafts",
      "/gmail/v1/users/me/watch",
      "/gmail/v1/users/me/messages/abc/attachments/att-1",
      "/gmail/v1/users/me/settings/sendAs",
    ];
    for (const path of blocked) {
      await expect(
        gmailGet({ path, getToken: async () => "token", fetchImpl, sleep: async () => undefined, randomMs: () => 0 }),
      ).rejects.toBeInstanceOf(GmailReadOnlyViolation);
    }
    expect(() => assertGmailReadOnly("POST", "/gmail/v1/users/me/messages/send")).toThrow(GmailReadOnlyViolation);
    expect(() => assertGmailReadOnly("DELETE", "/gmail/v1/users/me/messages/abc")).toThrow(GmailReadOnlyViolation);
    expect(() => assertGmailReadOnly("GET", "/gmail/v1/users/me/messages/abc")).not.toThrow();
  });
});
