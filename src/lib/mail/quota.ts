/**
 * Gmail API usage limits, read 2026-10-19.
 * https://developers.google.com/workspace/gmail/api/reference/quota
 * Page last updated 2026-10-16 UTC.
 *
 * Projects created on or after 1 May 2026 use these quotas. figcel-sender was
 * created in October 2026, so the current table applies:
 *   - 1,200,000 quota units per minute per project
 *   - 6,000 quota units per minute per user per project
 *   - getProfile: 1
 *   - history.list: 2
 *   - messages.list: 5
 *   - messages.get: 20, or 60 when format is full, raw, or html
 *   - messages.send: 100 (not called)
 *   - messages.attachments.get: 20 (not called)
 *
 * messages.list maxResults maximum is 500 (default 100):
 * https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
 * The error guide says not to batch more than 50 requests:
 * https://developers.google.com/workspace/gmail/api/guides/handle-errors
 *
 * A sync run gets at most 50 messages in full format: 50 * 60 = 3,000 units,
 * under the 6,000 per-user per-minute cap, with room for profile and history.
 */

export const GMAIL_QUOTA = {
  perProjectPerMinute: 1_200_000,
  perUserPerMinute: 6_000,
  getProfile: 1,
  historyList: 2,
  messagesList: 5,
  messagesGet: 20,
  messagesGetFull: 60,
  messagesSend: 100,
} as const;

/** Gmail's own maxResults ceiling for messages.list. We stay well under it. */
export const GMAIL_LIST_MAX_RESULTS = 500;

/** Page size for messages.list and history.list. Matches the batch-size guidance. */
export const GMAIL_PAGE_SIZE = 50;

/** Hard cap on messages fetched in one sync run. 50 * 60 units = 3,000 < 6,000. */
export const GMAIL_SYNC_LIMIT_MAX = 50;

export const GMAIL_SYNC_LIMIT_DEFAULT = 50;

export const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
] as const;

export function assertSyncLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > GMAIL_SYNC_LIMIT_MAX) {
    throw new Error(
      `--limit must be an integer from 1 to ${GMAIL_SYNC_LIMIT_MAX}. ` +
        `messages.get with format=full costs ${GMAIL_QUOTA.messagesGetFull} units, ` +
        `and the per-user cap is ${GMAIL_QUOTA.perUserPerMinute} units per minute ` +
        `(https://developers.google.com/workspace/gmail/api/reference/quota).`,
    );
  }
}
