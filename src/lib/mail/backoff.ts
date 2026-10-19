import { GMAIL_QUOTA } from "@/lib/mail/quota";

/**
 * Truncated exponential backoff from the Gmail quota guide.
 * https://developers.google.com/workspace/gmail/api/reference/quota
 * https://developers.google.com/workspace/gmail/api/guides/handle-errors
 *
 * Wait is min(2^n seconds + up to 1s of jitter, 32s). n starts at 0.
 * Retry 429, 5xx, and 403 rateLimitExceeded / userRateLimitExceeded.
 * Do not retry 404 (history expiry is handled by the sync) or other 403s.
 */

export const GMAIL_MAX_ATTEMPTS = 5;
export const GMAIL_MAX_BACKOFF_MS = 32_000;

const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_403_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

export class GmailApiError extends Error {
  readonly status: number;
  readonly reason: string | null;
  readonly path: string;

  constructor(status: number, reason: string | null, path: string, message: string) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
    this.reason = reason;
    this.path = path;
  }
}

export class GmailReadOnlyViolation extends Error {
  constructor(path: string) {
    super(`Refusing ${path}. Sync is read-only: no send, modify, label, trash, or delete calls.`);
    this.name = "GmailReadOnlyViolation";
  }
}

export function shouldRetryGmail(status: number, reason: string | null): boolean {
  if (RETRY_STATUSES.has(status)) return true;
  if (status === 403 && reason != null && RETRY_403_REASONS.has(reason)) return true;
  return false;
}

export function backoffDelayMs(attemptIndex: number, randomMs: number): number {
  const jitter = Math.max(0, Math.min(1000, randomMs));
  const exponential = 2 ** attemptIndex * 1000 + jitter;
  return Math.min(exponential, GMAIL_MAX_BACKOFF_MS);
}

export function quotaNote(): string {
  return (
    `Per-user budget is ${GMAIL_QUOTA.perUserPerMinute} units/minute. ` +
    `A full messages.get costs ${GMAIL_QUOTA.messagesGetFull}.`
  );
}
