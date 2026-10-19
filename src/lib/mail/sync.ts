import { INBOXES } from "@/lib/inboxes";
import type { Db } from "@/lib/db/pool";
import { Pool, type PoolClient } from "pg";
import { parseGmailMessage, type ParsedGmailMessage } from "@/lib/mail/parse";
import { GMAIL_PAGE_SIZE, assertSyncLimit } from "@/lib/mail/quota";
import type { GmailGetFormat, GmailReadClient } from "@/lib/mail/types";
import { stopFromInbound } from "@/lib/send/inbound";
import { touchKv } from "@/lib/send/settings";

export type ConnectResult =
  | { ok: true; email: string; historyId: string; messagesTotal: number | null }
  | { ok: false; email: string; error: string };

export type SyncResult =
  | {
      ok: true;
      email: string;
      mode: "full" | "partial";
      stored: number;
      removed: number;
      historyId: string;
    }
  | { ok: false; email: string; error: string };

type InboxRow = { id: string; email: string; history_id: string | null };

export function assertKnownInbox(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!INBOXES.some((inbox) => inbox.email === normalized)) {
    throw new Error(`Unknown inbox ${email}. Only the 15 Workspace inboxes can be checked or synced.`);
  }
  return normalized;
}

function isPool(db: Db): db is Pool {
  return typeof (db as Pool).connect === "function" && typeof (db as PoolClient).release !== "function";
}

async function withOptionalTransaction(db: Db, fn: (query: Db) => Promise<void>): Promise<void> {
  if (!isPool(db)) {
    await fn(db);
    return;
  }
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await fn(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Gmail error";
  return message.slice(0, 500);
}

async function loadInbox(db: Db, email: string): Promise<InboxRow> {
  const result = await db.query<InboxRow>(
    "SELECT id, email, history_id FROM inboxes WHERE email = $1",
    [email],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Inbox ${email} is not seeded. Run npm run migrate.`);
  return row;
}

async function markActive(db: Db, inboxId: string, historyId: string | null, synced: boolean): Promise<void> {
  await db.query(
    `UPDATE inboxes
     SET status = 'active',
         last_error = NULL,
         history_id = COALESCE($2, history_id),
         last_sync_at = CASE WHEN $3 THEN now() ELSE last_sync_at END
     WHERE id = $1`,
    [inboxId, historyId, synced],
  );
  await db.query(
    `UPDATE alerts
     SET acknowledged_at = now()
     WHERE inbox_id = $1 AND kind = 'inbox_disconnect' AND acknowledged_at IS NULL`,
    [inboxId],
  );
}

async function markDisconnected(db: Db, inboxId: string, error: unknown): Promise<void> {
  const detail = errorText(error);
  await db.query("UPDATE inboxes SET status = 'disconnected', last_error = $2 WHERE id = $1", [inboxId, detail]);
  const updated = await db.query(
    `UPDATE alerts
     SET detail = $2
     WHERE inbox_id = $1 AND kind = 'inbox_disconnect' AND acknowledged_at IS NULL`,
    [inboxId, detail],
  );
  if ((updated.rowCount ?? 0) === 0) {
    await db.query(
      "INSERT INTO alerts (kind, inbox_id, detail) VALUES ('inbox_disconnect', $1, $2)",
      [inboxId, detail],
    );
  }
}

async function upsertMessage(db: Db, inboxId: string, inboxEmail: string, parsed: ParsedGmailMessage, full: boolean): Promise<void> {
  await withOptionalTransaction(db, async (tx) => {
    const thread = await tx.query<{ id: string }>(
      `INSERT INTO threads (inbox_id, gmail_thread_id, subject, snippet, last_message_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (inbox_id, gmail_thread_id) DO UPDATE SET
         subject = COALESCE(EXCLUDED.subject, threads.subject),
         snippet = COALESCE(EXCLUDED.snippet, threads.snippet),
         last_message_at = CASE
           WHEN threads.last_message_at IS NULL THEN EXCLUDED.last_message_at
           WHEN EXCLUDED.last_message_at IS NULL THEN threads.last_message_at
           ELSE GREATEST(threads.last_message_at, EXCLUDED.last_message_at)
         END
       RETURNING id`,
      [inboxId, parsed.threadId, parsed.subject, parsed.snippet, parsed.internalDate],
    );
    const threadId = thread.rows[0].id;
    if (full) {
      const message = await tx.query<{ id: string }>(
        `INSERT INTO messages (
           inbox_id, thread_row_id, gmail_message_id, rfc_message_id, direction,
           from_email, from_name, to_addrs, cc_addrs, subject, body_text, body_html,
           snippet, internal_date, is_read, is_starred, is_archived, labels, has_attachments, removed_at
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12,
           $13, $14, $15, $16, $17, $18::jsonb, $19, NULL
         )
         ON CONFLICT (inbox_id, gmail_message_id) DO UPDATE SET
           thread_row_id = EXCLUDED.thread_row_id,
           rfc_message_id = EXCLUDED.rfc_message_id,
           direction = EXCLUDED.direction,
           from_email = EXCLUDED.from_email,
           from_name = EXCLUDED.from_name,
           to_addrs = EXCLUDED.to_addrs,
           cc_addrs = EXCLUDED.cc_addrs,
           subject = EXCLUDED.subject,
           body_text = EXCLUDED.body_text,
           body_html = EXCLUDED.body_html,
           snippet = EXCLUDED.snippet,
           internal_date = EXCLUDED.internal_date,
           is_read = EXCLUDED.is_read,
           is_starred = EXCLUDED.is_starred,
           is_archived = EXCLUDED.is_archived,
           labels = EXCLUDED.labels,
           has_attachments = EXCLUDED.has_attachments,
           removed_at = NULL
         RETURNING id`,
        [
          inboxId,
          threadId,
          parsed.gmailId,
          parsed.rfcMessageId,
          parsed.direction,
          parsed.fromEmail,
          parsed.fromName,
          JSON.stringify(parsed.to),
          JSON.stringify(parsed.cc),
          parsed.subject,
          parsed.bodyText,
          parsed.bodyHtml,
          parsed.snippet,
          parsed.internalDate,
          parsed.isRead,
          parsed.isStarred,
          parsed.isArchived,
          JSON.stringify(parsed.labelIds),
          parsed.attachments.length > 0,
        ],
      );
      const messageId = message.rows[0].id;
      await tx.query("DELETE FROM attachments WHERE message_id = $1", [messageId]);
      for (const attachment of parsed.attachments) {
        await tx.query(
          `INSERT INTO attachments (message_id, filename, mime_type, size_bytes, gmail_attachment_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [messageId, attachment.filename, attachment.mimeType, attachment.sizeBytes, attachment.gmailAttachmentId],
        );
      }
    } else {
      await tx.query(
        `UPDATE messages
         SET thread_row_id = $3,
             is_read = $4,
             is_starred = $5,
             is_archived = $6,
             labels = $7::jsonb,
             removed_at = NULL
         WHERE inbox_id = $1 AND gmail_message_id = $2`,
        [
          inboxId,
          parsed.gmailId,
          threadId,
          parsed.isRead,
          parsed.isStarred,
          parsed.isArchived,
          JSON.stringify(parsed.labelIds),
        ],
      );
    }
    await tx.query(
      `INSERT INTO processed_messages (inbox_id, gmail_message_id)
       VALUES ($1, $2)
       ON CONFLICT (inbox_id, gmail_message_id) DO NOTHING`,
      [inboxId, parsed.gmailId],
    );
    if (full && parsed.direction === "in") {
      await stopFromInbound(tx, {
        inboxId,
        gmailMessageId: parsed.gmailId,
        fromEmail: parsed.fromEmail,
        subject: parsed.subject,
        bodyText: parsed.bodyText,
      });
    }
  });
}

async function hasMessage(db: Db, inboxId: string, gmailId: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM messages WHERE inbox_id = $1 AND gmail_message_id = $2", [
    inboxId,
    gmailId,
  ]);
  return result.rows.length > 0;
}

async function fetchAndStore(
  db: Db,
  inbox: InboxRow,
  client: GmailReadClient,
  gmailId: string,
  format: GmailGetFormat,
): Promise<boolean> {
  const message = await client.getMessage(gmailId, format);
  if (!message) return false;
  const parsed = parseGmailMessage(message, inbox.email);
  await upsertMessage(db, inbox.id, inbox.email, parsed, format === "full");
  return true;
}

async function fullSync(db: Db, inbox: InboxRow, client: GmailReadClient, limit: number): Promise<{ stored: number; historyId: string }> {
  const ids: { id: string; threadId: string }[] = [];
  let pageToken: string | undefined;
  while (ids.length < limit) {
    const maxResults = Math.min(GMAIL_PAGE_SIZE, limit - ids.length);
    const page = await client.listMessages({ maxResults, pageToken });
    ids.push(...page.messages.slice(0, limit - ids.length));
    if (!page.nextPageToken || page.messages.length === 0) break;
    pageToken = page.nextPageToken;
  }

  let stored = 0;
  let newestHistoryId: string | null = null;
  for (const [index, ref] of ids.entries()) {
    const message = await client.getMessage(ref.id, "full");
    if (!message) continue;
    if (index === 0 && message.historyId) newestHistoryId = String(message.historyId);
    const parsed = parseGmailMessage(message, inbox.email);
    await upsertMessage(db, inbox.id, inbox.email, parsed, true);
    stored += 1;
  }
  if (!newestHistoryId) {
    const profile = await client.getProfile();
    newestHistoryId = profile.historyId;
  }
  return { stored, historyId: newestHistoryId };
}

async function partialSync(
  db: Db,
  inbox: InboxRow,
  client: GmailReadClient,
  limit: number,
): Promise<{ expired: true } | { expired: false; stored: number; removed: number; historyId: string }> {
  let pageToken: string | undefined;
  let cursor = inbox.history_id as string;
  let stored = 0;
  let removed = 0;
  let fetches = 0;

  for (;;) {
    const page = await client.listHistory({
      startHistoryId: cursor,
      pageToken,
      maxResults: GMAIL_PAGE_SIZE,
    });
    if (page.expired) return { expired: true };

    for (const record of page.history) {
      if (fetches >= limit) {
        return { expired: false, stored, removed, historyId: cursor };
      }
      const pending = new Set<string>();
      for (const item of record.messagesAdded ?? []) pending.add(item.id);
      for (const item of [...(record.labelsAdded ?? []), ...(record.labelsRemoved ?? [])]) pending.add(item.id);
      for (const id of pending) {
        const format: GmailGetFormat = (await hasMessage(db, inbox.id, id)) ? "minimal" : "full";
        if (await fetchAndStore(db, inbox, client, id, format)) stored += 1;
        fetches += 1;
      }
      for (const item of record.messagesDeleted ?? []) {
        const result = await db.query(
          `UPDATE messages SET removed_at = COALESCE(removed_at, now())
           WHERE inbox_id = $1 AND gmail_message_id = $2`,
          [inbox.id, item.id],
        );
        removed += result.rowCount ?? 0;
      }
      if (record.id) cursor = record.id;
    }

    if (!page.nextPageToken) {
      return { expired: false, stored, removed, historyId: page.historyId || cursor };
    }
    if (fetches >= limit) {
      return { expired: false, stored, removed, historyId: cursor };
    }
    pageToken = page.nextPageToken;
  }
}

/** users.getProfile for one known inbox. Does not store historyId; sync does that. */
export async function connectInbox(db: Db, email: string, client: GmailReadClient): Promise<ConnectResult> {
  const known = assertKnownInbox(email);
  const inbox = await loadInbox(db, known);
  try {
    const profile = await client.getProfile();
    if (profile.emailAddress.toLowerCase() !== known) {
      throw new Error(`Profile email ${profile.emailAddress} does not match ${known}`);
    }
    await markActive(db, inbox.id, null, false);
    return {
      ok: true,
      email: known,
      historyId: profile.historyId,
      messagesTotal: profile.messagesTotal ?? null,
    };
  } catch (error) {
    await markDisconnected(db, inbox.id, error);
    return { ok: false, email: known, error: errorText(error) };
  }
}

/**
 * Full sync when history_id is empty. Partial sync otherwise.
 * A history.list 404 means the cursor expired; fall back to a bounded full sync.
 * https://developers.google.com/workspace/gmail/api/guides/sync
 */
export async function syncInbox(
  db: Db,
  email: string,
  client: GmailReadClient,
  opts: { limit: number },
): Promise<SyncResult> {
  assertSyncLimit(opts.limit);
  const known = assertKnownInbox(email);
  const inbox = await loadInbox(db, known);
  try {
    let mode: "full" | "partial" = inbox.history_id ? "partial" : "full";
    let stored = 0;
    let removed = 0;
    let historyId: string;
    if (inbox.history_id) {
      const partial = await partialSync(db, inbox, client, opts.limit);
      if (partial.expired) {
        mode = "full";
        const full = await fullSync(db, inbox, client, opts.limit);
        stored = full.stored;
        historyId = full.historyId;
      } else {
        stored = partial.stored;
        removed = partial.removed;
        historyId = partial.historyId;
      }
    } else {
      const full = await fullSync(db, inbox, client, opts.limit);
      stored = full.stored;
      historyId = full.historyId;
    }
    await markActive(db, inbox.id, historyId, true);
    await touchKv(db, "poll_ok_at");
    return { ok: true, email: known, mode, stored, removed, historyId };
  } catch (error) {
    await markDisconnected(db, inbox.id, error);
    return { ok: false, email: known, error: errorText(error) };
  }
}
