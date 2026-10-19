import { GmailReadOnlyViolation } from "@/lib/mail/backoff";

const BLOCKED_MESSAGE_IDS = new Set([
  "send",
  "import",
  "insert",
  "batchModify",
  "batchDelete",
  "modify",
  "trash",
  "untrash",
  "delete",
]);

/**
 * Sync may only GET profile, message list, one message, or history.
 * messages.send, modify, trash, delete, labels, drafts, and attachment
 * downloads are rejected before any network call.
 */
export function assertGmailReadOnly(method: string, path: string): void {
  if (method !== "GET") throw new GmailReadOnlyViolation(`${method} ${path}`);
  const profile = "/gmail/v1/users/me/profile";
  const messages = "/gmail/v1/users/me/messages";
  const history = "/gmail/v1/users/me/history";
  if (path === profile || path === messages || path === history) return;
  const message = path.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
  if (message && !BLOCKED_MESSAGE_IDS.has(message[1])) return;
  throw new GmailReadOnlyViolation(`${method} ${path}`);
}
