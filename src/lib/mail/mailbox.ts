import type { Db } from "@/lib/db/pool";
import { normalizeEmail } from "@/lib/email/normalize";
import type { ReplyClass } from "@/lib/mail/classify";
import { REPLY_CLASSES } from "@/lib/mail/classify";
import { recordMirror, type MirrorAction } from "@/lib/mail/mirror";
import { audit } from "@/lib/send/settings";
import { etDateISO } from "@/lib/window";

export type MailView = "inbox" | "starred" | "snoozed" | "archive" | "all";

export type MailQuery = {
  inboxId?: string | null;
  q?: string | null;
  campaignId?: string | null;
  label?: string | null;
  view?: MailView;
};

export type ThreadSummary = {
  id: string;
  subject: string;
  snippet: string;
  inboxEmail: string;
  inboxId: string;
  when: string | null;
  unread: boolean;
  starred: boolean;
  classification: ReplyClass | null;
  contactId: string | null;
  contactEmail: string | null;
  campaign: string | null;
};

function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function releaseSnoozed(db: Db, now = new Date()): Promise<number> {
  const due = await db.query<{ id: string; inbox_id: string; gmail_message_id: string }>(
    `UPDATE messages SET snooze_until = NULL, is_archived = false
     WHERE snooze_until IS NOT NULL AND snooze_until <= $1
     RETURNING id, inbox_id, gmail_message_id`,
    [now],
  );
  for (const row of due.rows) {
    await recordMirror(db, { inboxId: row.inbox_id, gmailMessageId: row.gmail_message_id, action: "unsnooze" });
  }
  return due.rows.length;
}

export async function listThreads(db: Db, query: MailQuery = {}): Promise<ThreadSummary[]> {
  await releaseSnoozed(db);
  const q = query.q?.trim() ?? "";
  const view = query.view ?? "inbox";
  const result = await db.query<{
    id: string;
    subject: string | null;
    snippet: string | null;
    inbox_email: string;
    inbox_id: string;
    last_message_at: Date | null;
    unread: boolean;
    starred: boolean;
    classification: ReplyClass | null;
    contact_id: string | null;
    contact_email: string | null;
    campaign: string | null;
  }>(
    `SELECT t.id,
            COALESCE(t.subject, latest.subject, '(no subject)') AS subject,
            COALESCE(latest.snippet, t.snippet, '') AS snippet,
            i.email AS inbox_email,
            i.id AS inbox_id,
            t.last_message_at,
            EXISTS (
              SELECT 1 FROM messages u WHERE u.thread_row_id = t.id AND u.is_read = false AND u.removed_at IS NULL
            ) AS unread,
            EXISTS (
              SELECT 1 FROM messages s WHERE s.thread_row_id = t.id AND s.is_starred = true AND s.removed_at IS NULL
            ) AS starred,
            (
              SELECT m.classification FROM messages m
              WHERE m.thread_row_id = t.id AND m.classification IS NOT NULL AND m.removed_at IS NULL
              ORDER BY m.internal_date DESC NULLS LAST LIMIT 1
            ) AS classification,
            t.contact_id,
            c.display_email AS contact_email,
            camp.name AS campaign
     FROM threads t
     JOIN inboxes i ON i.id = t.inbox_id
     LEFT JOIN contacts c ON c.id = t.contact_id
     LEFT JOIN campaigns camp ON camp.id = t.campaign_id
     JOIN LATERAL (
       SELECT subject, snippet FROM messages
       WHERE thread_row_id = t.id AND removed_at IS NULL
       ORDER BY internal_date DESC NULLS LAST LIMIT 1
     ) latest ON true
     WHERE ($1::uuid IS NULL OR t.inbox_id = $1)
       AND ($2::uuid IS NULL OR t.campaign_id = $2 OR EXISTS (
         SELECT 1 FROM messages mc WHERE mc.thread_row_id = t.id AND mc.campaign_id = $2
       ))
       AND ($3::text IS NULL OR EXISTS (
         SELECT 1 FROM messages ml
         JOIN message_labels mlj ON mlj.message_id = ml.id
         JOIN labels lb ON lb.id = mlj.label_id
         WHERE ml.thread_row_id = t.id AND lb.name = $3
       ))
       AND ($4::text = '' OR EXISTS (
         SELECT 1 FROM messages mq
         WHERE mq.thread_row_id = t.id AND mq.removed_at IS NULL
           AND (
             mq.search_vector @@ plainto_tsquery('english', $4)
             OR mq.from_email ILIKE '%' || $5 || '%' ESCAPE '\\'
             OR COALESCE(mq.subject, '') ILIKE '%' || $5 || '%' ESCAPE '\\'
             OR mq.to_addrs::text ILIKE '%' || $5 || '%' ESCAPE '\\'
             OR mq.cc_addrs::text ILIKE '%' || $5 || '%' ESCAPE '\\'
             OR COALESCE(mq.body_text, '') ILIKE '%' || $5 || '%' ESCAPE '\\'
           )
       ))
       AND (
         $6 = 'all'
         OR ($6 = 'starred' AND EXISTS (
           SELECT 1 FROM messages ms WHERE ms.thread_row_id = t.id AND ms.is_starred AND ms.removed_at IS NULL
         ))
         OR ($6 = 'archive' AND NOT EXISTS (
           SELECT 1 FROM messages ma WHERE ma.thread_row_id = t.id AND ma.is_archived = false AND ma.removed_at IS NULL
         ))
         OR ($6 = 'snoozed' AND EXISTS (
           SELECT 1 FROM messages mz WHERE mz.thread_row_id = t.id AND mz.snooze_until IS NOT NULL AND mz.removed_at IS NULL
         ))
         OR ($6 = 'inbox' AND EXISTS (
           SELECT 1 FROM messages mi
           WHERE mi.thread_row_id = t.id AND mi.removed_at IS NULL AND mi.is_archived = false
             AND (mi.snooze_until IS NULL OR mi.snooze_until <= now())
         ))
       )
     ORDER BY t.last_message_at DESC NULLS LAST
     LIMIT 200`,
    [query.inboxId ?? null, query.campaignId ?? null, query.label ?? null, q, likeEscape(q), view],
  );
  return result.rows.map((row) => ({
    id: row.id,
    subject: row.subject ?? "(no subject)",
    snippet: row.snippet ?? "",
    inboxEmail: row.inbox_email,
    inboxId: row.inbox_id,
    when: row.last_message_at ? row.last_message_at.toISOString().replace("T", " ").slice(0, 16) + " UTC" : null,
    unread: row.unread,
    starred: row.starred,
    classification: row.classification,
    contactId: row.contact_id,
    contactEmail: row.contact_email,
    campaign: row.campaign,
  }));
}

export type ThreadMessage = {
  id: string;
  fromEmail: string | null;
  fromName: string | null;
  to: unknown;
  cc: unknown;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  direction: "in" | "out";
  at: string | null;
  isRead: boolean;
  isStarred: boolean;
  classification: ReplyClass | null;
  inboxEmail: string;
  rfcMessageId: string | null;
  attachments: { filename: string | null; mimeType: string | null; sizeBytes: number | null }[];
};

export type ThreadContext = {
  contact: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    title: string | null;
    timezone: string | null;
    verification: string;
  } | null;
  campaign: { name: string; step: number; variant: string | null; status: string } | null;
  timeline: { kind: string; at: string; detail: string }[];
  verification: { status: string; provider: string | null; at: string | null } | null;
  inbox: { email: string; status: string; cap: number; sentToday: number; pause: string | null };
  otherThreads: { id: string; subject: string }[];
  notes: { id: string; body: string; at: string }[];
  tags: string[];
};

export type ThreadDetail = {
  id: string;
  subject: string;
  gmailThreadId: string;
  inboxEmail: string;
  inboxId: string;
  messages: ThreadMessage[];
  context: ThreadContext;
};

async function linkContact(db: Db, threadId: string): Promise<void> {
  const inbound = await db.query<{ from_email: string }>(
    `SELECT from_email FROM messages WHERE thread_row_id = $1 AND direction = 'in' AND from_email IS NOT NULL`,
    [threadId],
  );
  for (const row of inbound.rows) {
    const normalized = normalizeEmail(row.from_email);
    if (!normalized) continue;
    const contact = await db.query<{ id: string }>("SELECT id FROM contacts WHERE normalized_email = $1", [normalized]);
    if (contact.rows[0]) {
      await db.query("UPDATE threads SET contact_id = COALESCE(contact_id, $2) WHERE id = $1", [threadId, contact.rows[0].id]);
      return;
    }
  }
}

export async function loadThread(db: Db, threadId: string): Promise<ThreadDetail | null> {
  await linkContact(db, threadId);
  const thread = await db.query<{
    id: string;
    subject: string | null;
    gmail_thread_id: string;
    inbox_id: string;
    inbox_email: string;
    contact_id: string | null;
    campaign_id: string | null;
  }>(
    `SELECT t.id, t.subject, t.gmail_thread_id, t.inbox_id, i.email AS inbox_email, t.contact_id, t.campaign_id
     FROM threads t JOIN inboxes i ON i.id = t.inbox_id WHERE t.id = $1`,
    [threadId],
  );
  const row = thread.rows[0];
  if (!row) return null;
  const messages = await db.query<{
    id: string;
    from_email: string | null;
    from_name: string | null;
    to_addrs: unknown;
    cc_addrs: unknown;
    subject: string | null;
    body_text: string | null;
    body_html: string | null;
    direction: "in" | "out";
    internal_date: Date | null;
    is_read: boolean;
    is_starred: boolean;
    classification: ReplyClass | null;
    rfc_message_id: string | null;
  }>(
    `SELECT id, from_email, from_name, to_addrs, cc_addrs, subject, body_text, body_html,
            direction, internal_date, is_read, is_starred, classification, rfc_message_id
     FROM messages WHERE thread_row_id = $1 AND removed_at IS NULL
     ORDER BY internal_date ASC NULLS LAST`,
    [threadId],
  );
  const attachments = await db.query<{ message_id: string; filename: string | null; mime_type: string | null; size_bytes: number | null }>(
    `SELECT a.message_id, a.filename, a.mime_type, a.size_bytes
     FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.thread_row_id = $1`,
    [threadId],
  );
  const byMessage = new Map<string, ThreadMessage["attachments"]>();
  for (const item of attachments.rows) {
    const list = byMessage.get(item.message_id) ?? [];
    list.push({ filename: item.filename, mimeType: item.mime_type, sizeBytes: item.size_bytes });
    byMessage.set(item.message_id, list);
  }
  const context = await loadContext(db, row);
  return {
    id: row.id,
    subject: row.subject ?? messages.rows[0]?.subject ?? "(no subject)",
    gmailThreadId: row.gmail_thread_id,
    inboxEmail: row.inbox_email,
    inboxId: row.inbox_id,
    messages: messages.rows.map((message) => ({
      id: message.id,
      fromEmail: message.from_email,
      fromName: message.from_name,
      to: message.to_addrs,
      cc: message.cc_addrs,
      subject: message.subject,
      bodyText: message.body_text,
      bodyHtml: message.body_html,
      direction: message.direction,
      at: message.internal_date ? message.internal_date.toISOString().replace("T", " ").slice(0, 16) + " UTC" : null,
      isRead: message.is_read,
      isStarred: message.is_starred,
      classification: message.classification,
      inboxEmail: row.inbox_email,
      rfcMessageId: message.rfc_message_id,
      attachments: byMessage.get(message.id) ?? [],
    })),
    context,
  };
}

async function loadContext(
  db: Db,
  thread: { id: string; inbox_id: string; inbox_email: string; contact_id: string | null; campaign_id: string | null },
): Promise<ThreadContext> {
  const today = etDateISO(new Date());
  const inbox = await db.query<{ status: string; daily_cap: number; sent: string; pause: string | null }>(
    `SELECT i.status, i.daily_cap,
            (SELECT COUNT(*)::text FROM sends_counting_toward_cap s WHERE s.inbox_id = i.id AND s.et_date = $2) AS sent,
            (SELECT p.rule FROM pauses p WHERE p.resumed_at IS NULL AND (
               (p.scope = 'inbox' AND p.target = i.email) OR (p.scope = 'domain' AND p.target = i.domain) OR p.scope = 'fleet'
             ) LIMIT 1) AS pause
     FROM inboxes i WHERE i.id = $1`,
    [thread.inbox_id, today],
  );
  const health = inbox.rows[0];
  let contact: ThreadContext["contact"] = null;
  let campaign: ThreadContext["campaign"] = null;
  let verification: ThreadContext["verification"] = null;
  let timeline: ThreadContext["timeline"] = [];
  let notes: ThreadContext["notes"] = [];
  let tags: string[] = [];
  let otherThreads: ThreadContext["otherThreads"] = [];
  if (thread.contact_id) {
    const contactRow = await db.query<{
      id: string;
      display_email: string;
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      title: string | null;
      timezone: string | null;
      verification_status: string;
    }>("SELECT id, display_email, first_name, last_name, company, title, timezone, verification_status FROM contacts WHERE id = $1", [
      thread.contact_id,
    ]);
    const c = contactRow.rows[0];
    if (c) {
      contact = {
        id: c.id,
        email: c.display_email,
        firstName: c.first_name,
        lastName: c.last_name,
        company: c.company,
        title: c.title,
        timezone: c.timezone,
        verification: c.verification_status,
      };
    }
    const verify = await db.query<{ provider: string; status: string; checked_at: Date }>(
      `SELECT provider, status, checked_at FROM verification_results
       WHERE contact_id = $1 ORDER BY checked_at DESC LIMIT 1`,
      [thread.contact_id],
    );
    if (verify.rows[0]) {
      verification = {
        status: verify.rows[0].status,
        provider: verify.rows[0].provider,
        at: verify.rows[0].checked_at.toISOString().replace("T", " ").slice(0, 16) + " UTC",
      };
    } else if (contact) {
      verification = { status: contact.verification, provider: null, at: null };
    }
    const enrollment = await db.query<{ name: string; next_step: number; variant: string | null; status: string }>(
      `SELECT camp.name, e.next_step, e.variant, e.status
       FROM enrollments e JOIN campaigns camp ON camp.id = e.campaign_id
       WHERE e.contact_id = $1 AND ($2::uuid IS NULL OR e.campaign_id = $2)
       ORDER BY e.updated_at DESC LIMIT 1`,
      [thread.contact_id, thread.campaign_id],
    );
    if (enrollment.rows[0]) {
      campaign = {
        name: enrollment.rows[0].name,
        step: enrollment.rows[0].next_step,
        variant: enrollment.rows[0].variant,
        status: enrollment.rows[0].status,
      };
    }
    const events = await db.query<{ kind: string; occurred_at: Date; detail: unknown }>(
      `SELECT kind, occurred_at, detail FROM events WHERE contact_id = $1 ORDER BY occurred_at DESC LIMIT 30`,
      [thread.contact_id],
    );
    timeline = events.rows.map((event) => ({
      kind: event.kind,
      at: event.occurred_at.toISOString().replace("T", " ").slice(0, 16) + " UTC",
      detail: typeof event.detail === "string" ? event.detail : JSON.stringify(event.detail ?? {}),
    }));
    const noteRows = await db.query<{ id: string; body: string; created_at: Date }>(
      "SELECT id, body, created_at FROM contact_notes WHERE contact_id = $1 ORDER BY created_at DESC",
      [thread.contact_id],
    );
    notes = noteRows.rows.map((note) => ({
      id: note.id,
      body: note.body,
      at: note.created_at.toISOString().replace("T", " ").slice(0, 16) + " UTC",
    }));
    const tagRows = await db.query<{ name: string }>(
      `SELECT t.name FROM tags t JOIN contact_tags ct ON ct.tag_id = t.id WHERE ct.contact_id = $1 ORDER BY t.name`,
      [thread.contact_id],
    );
    tags = tagRows.rows.map((tag) => tag.name);
    const others = await db.query<{ id: string; subject: string | null }>(
      `SELECT id, subject FROM threads WHERE contact_id = $1 AND id <> $2 ORDER BY last_message_at DESC NULLS LAST LIMIT 8`,
      [thread.contact_id, thread.id],
    );
    otherThreads = others.rows.map((item) => ({ id: item.id, subject: item.subject ?? "(no subject)" }));
  }
  return {
    contact,
    campaign,
    timeline,
    verification,
    inbox: {
      email: thread.inbox_email,
      status: health?.status ?? "unknown",
      cap: health?.daily_cap ?? 0,
      sentToday: Number(health?.sent ?? 0),
      pause: health?.pause ?? null,
    },
    otherThreads,
    notes,
    tags,
  };
}

async function messageRef(db: Db, messageId: string): Promise<{ id: string; inboxId: string; gmailId: string; threadId: string }> {
  const result = await db.query<{ id: string; inbox_id: string; gmail_message_id: string; thread_row_id: string }>(
    "SELECT id, inbox_id, gmail_message_id, thread_row_id FROM messages WHERE id = $1",
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("message not found");
  return { id: row.id, inboxId: row.inbox_id, gmailId: row.gmail_message_id, threadId: row.thread_row_id };
}

export async function setMessageState(
  db: Db,
  input: {
    messageId: string;
    read?: boolean;
    starred?: boolean;
    archived?: boolean;
    snoozeUntil?: Date | null;
    actor: string;
    source: "ui" | "api" | "system";
  },
): Promise<void> {
  const ref = await messageRef(db, input.messageId);
  if (input.read != null) {
    await db.query("UPDATE messages SET is_read = $2 WHERE id = $1", [ref.id, input.read]);
    await recordMirror(db, { inboxId: ref.inboxId, gmailMessageId: ref.gmailId, action: input.read ? "read" : "unread" });
  }
  if (input.starred != null) {
    await db.query("UPDATE messages SET is_starred = $2 WHERE id = $1", [ref.id, input.starred]);
    await recordMirror(db, { inboxId: ref.inboxId, gmailMessageId: ref.gmailId, action: input.starred ? "star" : "unstar" });
  }
  if (input.archived != null) {
    await db.query("UPDATE messages SET is_archived = $2 WHERE id = $1", [ref.id, input.archived]);
    await recordMirror(db, {
      inboxId: ref.inboxId,
      gmailMessageId: ref.gmailId,
      action: input.archived ? "archive" : "unarchive",
    });
  }
  if (input.snoozeUntil !== undefined) {
    await db.query("UPDATE messages SET snooze_until = $2, is_archived = CASE WHEN $2::timestamptz IS NULL THEN is_archived ELSE true END WHERE id = $1", [
      ref.id,
      input.snoozeUntil,
    ]);
    await recordMirror(db, {
      inboxId: ref.inboxId,
      gmailMessageId: ref.gmailId,
      action: input.snoozeUntil ? "snooze" : "unsnooze",
      payload: { until: input.snoozeUntil?.toISOString() ?? null },
    });
  }
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "mail.state",
    entityType: "messages",
    entityId: ref.id,
    detail: { read: input.read, starred: input.starred, archived: input.archived, snoozeUntil: input.snoozeUntil?.toISOString() ?? null },
  });
}

export async function setThreadArchived(db: Db, threadId: string, archived: boolean, actor: string, source: "ui" | "api" | "system"): Promise<void> {
  const messages = await db.query<{ id: string }>("SELECT id FROM messages WHERE thread_row_id = $1 AND removed_at IS NULL", [threadId]);
  for (const message of messages.rows) {
    await setMessageState(db, { messageId: message.id, archived, actor, source });
  }
}

export async function setThreadRead(
  db: Db,
  threadId: string,
  read: boolean,
  actor: string,
  source: "ui" | "api" | "system",
): Promise<void> {
  const messages = await db.query<{ id: string }>(
    "SELECT id FROM messages WHERE thread_row_id = $1 AND removed_at IS NULL AND is_read = $2",
    [threadId, !read],
  );
  for (const message of messages.rows) {
    await setMessageState(db, { messageId: message.id, read, actor, source });
  }
}

export async function setThreadStar(db: Db, threadId: string, starred: boolean, actor: string, source: "ui" | "api" | "system"): Promise<void> {
  const latest = await db.query<{ id: string; is_starred: boolean }>(
    `SELECT id, is_starred FROM messages WHERE thread_row_id = $1 AND removed_at IS NULL
     ORDER BY internal_date DESC NULLS LAST LIMIT 1`,
    [threadId],
  );
  const row = latest.rows[0];
  if (!row) return;
  await setMessageState(db, { messageId: row.id, starred, actor, source });
}

export async function applyLabel(
  db: Db,
  input: { messageId: string; name: string; actor: string; source: "ui" | "api" | "system"; remove?: boolean },
): Promise<void> {
  const ref = await messageRef(db, input.messageId);
  const label = await db.query<{ id: string }>(
    `INSERT INTO labels (inbox_id, name, kind) VALUES ($1, $2, 'user')
     ON CONFLICT (inbox_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [ref.inboxId, input.name.trim()],
  );
  const labelId = label.rows[0].id;
  if (input.remove) {
    await db.query("DELETE FROM message_labels WHERE message_id = $1 AND label_id = $2", [ref.id, labelId]);
    await recordMirror(db, {
      inboxId: ref.inboxId,
      gmailMessageId: ref.gmailId,
      action: "label_remove",
      payload: { remove: [input.name.trim()] },
    });
  } else {
    await db.query(
      "INSERT INTO message_labels (message_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [ref.id, labelId],
    );
    await recordMirror(db, {
      inboxId: ref.inboxId,
      gmailMessageId: ref.gmailId,
      action: "label_add",
      payload: { add: [input.name.trim()] },
    });
  }
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: input.remove ? "mail.label_remove" : "mail.label_add",
    entityType: "messages",
    entityId: ref.id,
    detail: { name: input.name.trim() },
  });
}

export async function relabelMessage(
  db: Db,
  input: { messageId: string; classification: ReplyClass; actor: string; source: "ui" | "api" | "system" },
): Promise<void> {
  if (!REPLY_CLASSES.includes(input.classification)) throw new Error("unknown classification");
  const ref = await messageRef(db, input.messageId);
  const previous = await db.query<{ classification: string | null }>("SELECT classification FROM messages WHERE id = $1", [ref.id]);
  await db.query("UPDATE messages SET classification = $2 WHERE id = $1", [ref.id, input.classification]);
  const label = await db.query<{ id: string }>(
    `INSERT INTO labels (inbox_id, name, kind) VALUES (NULL, $1, 'classification')
     ON CONFLICT (name) WHERE inbox_id IS NULL DO UPDATE SET kind = 'classification'
     RETURNING id`,
    [input.classification],
  );
  await db.query("INSERT INTO message_labels (message_id, label_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    ref.id,
    label.rows[0].id,
  ]);
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "classification.change",
    entityType: "messages",
    entityId: ref.id,
    detail: { from: previous.rows[0]?.classification ?? null, to: input.classification },
  });
}

export async function addNote(
  db: Db,
  input: { contactId: string; body: string; actor: string; source: "ui" | "api" | "system" },
): Promise<void> {
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO contact_notes (contact_id, body, author) VALUES ($1, $2, $3) RETURNING id",
    [input.contactId, input.body.trim(), input.actor],
  );
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "contact.note",
    entityType: "contacts",
    entityId: input.contactId,
    detail: { noteId: inserted.rows[0].id },
  });
}

export async function setTag(
  db: Db,
  input: { contactId: string; name: string; remove?: boolean; actor: string; source: "ui" | "api" | "system" },
): Promise<void> {
  const name = input.name.trim().toLowerCase();
  if (!name) throw new Error("tag name is required");
  const tag = await db.query<{ id: string }>(
    "INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    [name],
  );
  if (input.remove) {
    await db.query("DELETE FROM contact_tags WHERE contact_id = $1 AND tag_id = $2", [input.contactId, tag.rows[0].id]);
  } else {
    await db.query(
      "INSERT INTO contact_tags (contact_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [input.contactId, tag.rows[0].id],
    );
  }
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: input.remove ? "contact.tag_remove" : "contact.tag_add",
    entityType: "contacts",
    entityId: input.contactId,
    detail: { name },
  });
}

export async function listTemplates(db: Db): Promise<{ id: string; name: string; subject: string | null; body: string }[]> {
  const result = await db.query<{ id: string; name: string; subject: string | null; body: string }>(
    "SELECT id, name, subject, body FROM reply_templates ORDER BY name",
  );
  return result.rows;
}

export async function saveTemplate(
  db: Db,
  input: { name: string; subject?: string | null; body: string; actor: string; source: "ui" | "api" | "system" },
): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    "INSERT INTO reply_templates (name, subject, body) VALUES ($1, $2, $3) RETURNING id",
    [input.name.trim(), input.subject ?? null, input.body],
  );
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "template.save",
    entityType: "reply_templates",
    entityId: inserted.rows[0].id,
    detail: { name: input.name.trim() },
  });
  return inserted.rows[0].id;
}

export type { MirrorAction };
