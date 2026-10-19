import { randomBytes } from "node:crypto";
import { HARD_MAX_PER_INBOX, HARD_MAX_TOTAL } from "@/lib/caps";
import type { Db } from "@/lib/db/pool";
import { normalizeEmail } from "@/lib/email/normalize";
import { isUnset, readSendMode, readSendingEnabled } from "@/lib/gates";
import { effectiveApproval } from "@/lib/gates";
import type { MailAdapter } from "@/lib/mail/adapter";
import { htmlToText, sanitizeHtml } from "@/lib/mail/sanitize";
import { deliverBehindGates } from "@/lib/send/execute";
import { countingTowardCap, fleetCeiling, prospectInboxCap } from "@/lib/send/capacity";
import { buildRichMime, unsubscribeUrls, type OutboundAttachment } from "@/lib/send/mime";
import { loadSendSettings } from "@/lib/send/settings";
import { inboxPaused } from "@/lib/send/stops";
import { withFooter } from "@/lib/send/template";
import { etDateISO } from "@/lib/window";

export type ComposeMode = "reply" | "reply_all" | "forward" | "new";

export type ComposeAttachment = { filename: string; mimeType: string; contentBase64: string };

export type ComposeInput = {
  inboxEmail: string;
  mode: ComposeMode;
  sourceMessageId?: string | null;
  to: string[];
  cc?: string[];
  subject: string;
  html: string;
  text?: string | null;
  attachments?: ComposeAttachment[];
  clientToken?: string;
  actor: string;
  source: "ui" | "api" | "system";
  now?: Date;
  sendingEnabled?: boolean;
  sendMode?: "dry-run" | "seed-only" | "live";
  adapter?: MailAdapter;
};

export type ComposeResult = {
  outcome: "drafted" | "sent" | "deferred" | "skipped" | "already_locked";
  reason?: string;
  draftId?: string;
  mime?: string;
};

const MAX_ATTACHMENT = 1_000_000;
const MAX_FILES = 3;

type SourceMessage = {
  id: string;
  inbox_id: string;
  inbox_email: string;
  sender_name: string;
  gmail_thread_id: string;
  rfc_message_id: string | null;
  references_chain: string | null;
  from_email: string | null;
  to_addrs: { email?: string }[];
  cc_addrs: { email?: string }[];
  subject: string | null;
};

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" && "email" in item ? String(item.email) : ""))
    .filter(Boolean);
}

async function loadSource(db: Db, messageId: string, inboxEmail: string): Promise<SourceMessage> {
  const result = await db.query<SourceMessage>(
    `SELECT m.id, m.inbox_id, i.email AS inbox_email, i.sender_name, t.gmail_thread_id,
            m.rfc_message_id, NULL::text AS references_chain, m.from_email, m.to_addrs, m.cc_addrs, m.subject
     FROM messages m
     JOIN inboxes i ON i.id = m.inbox_id
     JOIN threads t ON t.id = m.thread_row_id
     WHERE m.id = $1`,
    [messageId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("source message not found");
  if (row.inbox_email !== inboxEmail) {
    throw new Error(`reply must leave from the original inbox ${row.inbox_email}`);
  }
  const prior = await db.query<{ rfc_message_id: string | null }>(
    `SELECT rfc_message_id FROM messages
     WHERE thread_row_id = (SELECT thread_row_id FROM messages WHERE id = $1)
       AND rfc_message_id IS NOT NULL
     ORDER BY internal_date ASC NULLS LAST`,
    [messageId],
  );
  row.references_chain = prior.rows.map((item) => item.rfc_message_id).filter(Boolean).join(" ");
  return row;
}

async function suppressed(db: Db, normalized: string): Promise<boolean> {
  const email = await db.query("SELECT 1 FROM suppression WHERE kind = 'email' AND value = $1", [normalized]);
  if (email.rows.length > 0) return true;
  const domain = normalized.split("@")[1] ?? "";
  const labels = domain.split(".");
  const candidates: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) candidates.push(labels.slice(i).join("."));
  if (candidates.length === 0) return false;
  const hit = await db.query("SELECT 1 FROM suppression WHERE kind = 'domain' AND value = ANY($1::text[])", [candidates]);
  return hit.rows.length > 0;
}

async function isProspect(db: Db, normalized: string): Promise<{ contactId: string; token: string | null } | null> {
  const result = await db.query<{ id: string; unsub_token: string | null }>(
    `SELECT c.id, e.unsub_token
     FROM contacts c
     JOIN enrollments e ON e.contact_id = c.id
     WHERE c.normalized_email = $1 AND e.status IN ('pending', 'active')
     LIMIT 1`,
    [normalized],
  );
  const row = result.rows[0];
  return row ? { contactId: row.id, token: row.unsub_token } : null;
}

function decodeAttachments(files: ComposeAttachment[]): OutboundAttachment[] {
  if (files.length > MAX_FILES) throw new Error("too many attachments");
  return files.map((file) => {
    const content = Buffer.from(file.contentBase64, "base64");
    if (content.length > MAX_ATTACHMENT) throw new Error(`attachment ${file.filename} is over 1 MB`);
    return { filename: file.filename, mimeType: file.mimeType || "application/octet-stream", content };
  });
}

/**
 * Manual mail uses the same locks as a campaign send: approval off stores a
 * Review draft and does not call the adapter. Caps include the manual row.
 */
export async function composeManual(db: Db, input: ComposeInput): Promise<ComposeResult> {
  const now = input.now ?? new Date();
  const settings = await loadSendSettings(db);
  const approval = effectiveApproval(settings.approvalMode, null);
  const inbox = await db.query<{ id: string; email: string; domain: string; status: string; sender_name: string }>(
    "SELECT id, email, domain, status, sender_name FROM inboxes WHERE email = $1",
    [input.inboxEmail.trim().toLowerCase()],
  );
  const box = inbox.rows[0];
  if (!box) return { outcome: "skipped", reason: "inbox not found" };

  const source = input.sourceMessageId ? await loadSource(db, input.sourceMessageId, box.email) : null;
  if ((input.mode === "reply" || input.mode === "reply_all" || input.mode === "forward") && !source) {
    return { outcome: "skipped", reason: "a reply or forward needs the original message" };
  }

  const to = [...new Set(input.to.map((item) => item.trim()).filter(Boolean))];
  const cc = [...new Set((input.cc ?? []).map((item) => item.trim()).filter(Boolean))];
  if (input.mode === "reply" && source) {
    const counterparty = source.from_email && source.from_email !== box.email ? source.from_email : addresses(source.to_addrs)[0];
    if (to.length === 0 && counterparty) to.push(counterparty);
  }
  if (input.mode === "reply_all" && source) {
    const everyone = [source.from_email, ...addresses(source.to_addrs), ...addresses(source.cc_addrs)].filter(
      (item): item is string => typeof item === "string" && item.toLowerCase() !== box.email,
    );
    for (const person of everyone) {
      if (!to.includes(person) && !cc.includes(person)) cc.push(person);
    }
  }
  if (to.length === 0) return { outcome: "skipped", reason: "a recipient is required" };

  const normalizedTo = to.map((item) => normalizeEmail(item));
  if (normalizedTo.some((item) => !item)) return { outcome: "skipped", reason: "a recipient address is not valid" };
  for (const item of normalizedTo) {
    if (item && (await suppressed(db, item))) return { outcome: "skipped", reason: `suppressed: ${item}` };
  }

  let prospect: { contactId: string; token: string | null } | null = null;
  for (const item of normalizedTo) {
    if (!item) continue;
    prospect = await isProspect(db, item);
    if (prospect) break;
  }

  const html = sanitizeHtml(input.html);
  let text = (input.text?.trim() ? input.text : htmlToText(html)).trim();
  let listHttps: string | null = null;
  let listMailto: string | null = null;
  if (prospect) {
    const token = prospect.token ?? "manual";
    const urls = unsubscribeUrls(settings.unsubscribeHttpsBase, token, box.email);
    listHttps = urls.https;
    listMailto = urls.mailto;
    text = withFooter(text, {
      unsubscribeUrl: urls.https,
      legalName: settings.legalName,
      postalAddress: settings.postalAddress,
    }).trimEnd();
  }
  const htmlWithFooter = prospect ? appendFooterHtml(html, listHttps ?? "", settings.legalName, settings.postalAddress) : html;

  const subject = input.subject.trim() || (input.mode === "forward" ? `Fwd: ${source?.subject ?? ""}` : source?.subject ?? "");
  const replySubject =
    input.mode === "forward" || input.mode === "new" ? subject : subject.startsWith("Re:") ? subject : `Re: ${subject.replace(/^Re:\s*/i, "")}`;
  const outboundSubject = input.mode === "new" || input.mode === "forward" ? subject : replySubject;
  const inReplyTo = input.mode === "reply" || input.mode === "reply_all" ? source?.rfc_message_id ?? null : null;
  const references = inReplyTo ? source?.references_chain || inReplyTo : null;
  const files = decodeAttachments(input.attachments ?? []);
  const built = buildRichMime({
    fromEmail: box.email,
    fromName: box.sender_name,
    to,
    cc,
    subject: outboundSubject,
    text,
    html: htmlWithFooter,
    date: now,
    inReplyTo,
    references,
    listUnsubscribeHttps: listHttps,
    listUnsubscribeMailto: listMailto,
    attachments: files,
  });

  if (approval === "review") {
    const draft = await db.query<{ id: string }>(
      `INSERT INTO review_drafts (
         enrollment_id, step_number, subject, body, html_body, inbox_id, state, kind,
         to_addrs, cc_addrs, gmail_thread_id, in_reply_to, references_header, compose_mode,
         source_message_id, attachments
       ) VALUES (
         NULL, 1, $1, $2, $3, $4, 'pending', 'manual',
         $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb
       ) RETURNING id`,
      [
        outboundSubject,
        text,
        htmlWithFooter,
        box.id,
        JSON.stringify(to.map((email) => ({ email }))),
        JSON.stringify(cc.map((email) => ({ email }))),
        input.mode === "forward" || input.mode === "new" ? null : source?.gmail_thread_id ?? null,
        inReplyTo,
        references,
        input.mode,
        source?.id ?? null,
        JSON.stringify(input.attachments ?? []),
      ],
    );
    return { outcome: "drafted", draftId: draft.rows[0].id, mime: built.mime, reason: "approval is off" };
  }

  const sendingEnabled = input.sendingEnabled ?? readSendingEnabled();
  const sendMode = input.sendMode ?? readSendMode();
  if (sendMode === "dry-run") return { outcome: "deferred", reason: "dry-run mode: nothing is sent", mime: built.mime };
  if (!sendingEnabled) return { outcome: "deferred", reason: "SENDING_ENABLED is not true", mime: built.mime };
  if (prospect && isUnset(settings.legalName)) return { outcome: "deferred", reason: "TODO: legal name", mime: built.mime };
  if (prospect && isUnset(settings.postalAddress)) return { outcome: "deferred", reason: "TODO: postal address", mime: built.mime };
  if (prospect && isUnset(settings.unsubscribeHttpsBase)) return { outcome: "deferred", reason: "TODO: unsubscribe url", mime: built.mime };
  if (sendMode === "seed-only") {
    for (const item of normalizedTo) {
      const seed = await db.query("SELECT 1 FROM seed_addresses WHERE email = $1", [item]);
      if (seed.rows.length === 0) return { outcome: "deferred", reason: `seed-only mode: ${item} is not in seed_addresses`, mime: built.mime };
    }
  }
  if (box.status !== "active") return { outcome: "deferred", reason: `inbox ${box.email} is ${box.status}`, mime: built.mime };
  const paused = await inboxPaused(db, box);
  if (paused) return { outcome: "deferred", reason: `inbox paused: ${paused.rule}`, mime: built.mime };

  const etDate = etDateISO(now);
  const inboxCap = await prospectInboxCap(db, box, etDate, settings.ramp, settings.maxPerInbox);
  const inboxCount = await countingTowardCap(db, etDate, box.id);
  const fleetCount = await countingTowardCap(db, etDate);
  if (inboxCount >= Math.min(inboxCap, HARD_MAX_PER_INBOX)) {
    return { outcome: "deferred", reason: `per-inbox cap reached (${inboxCap})`, mime: built.mime };
  }
  if (fleetCount >= fleetCeiling(settings.maxTotal)) {
    return { outcome: "deferred", reason: `fleet cap reached (${Math.min(settings.maxTotal, HARD_MAX_TOTAL)})`, mime: built.mime };
  }

  const token = input.clientToken ?? randomBytes(12).toString("hex");
  const contactId = prospect?.contactId ?? (await contactFor(db, normalizedTo[0] ?? ""));
  const reserved = await db.query<{ id: string }>(
    `INSERT INTO sends (contact_id, inbox_id, kind, step_number, et_date, state, client_token)
     VALUES ($1, $2, 'manual', 1, $3, 'reserved', $4)
     ON CONFLICT (client_token) WHERE client_token IS NOT NULL DO NOTHING
     RETURNING id`,
    [contactId, box.id, etDate, token],
  );
  const sendId = reserved.rows[0]?.id;
  if (!sendId) return { outcome: "already_locked", reason: "this compose was already reserved", mime: built.mime };
  await db.query("UPDATE sends SET state = 'sending' WHERE id = $1", [sendId]);
  if (!input.adapter) return { outcome: "deferred", reason: "no send adapter on this process", mime: built.mime };
  const sent = await deliverBehindGates(input.adapter, { action: "send" }, {
    from: box.email,
    to: to.join(", "),
    raw: built.raw,
    threadId: input.mode === "forward" || input.mode === "new" ? undefined : source?.gmail_thread_id,
  });
  await db.query(
    "UPDATE sends SET state = 'sent', sent_at = $2, gmail_id = $3, thread_id = $4, rfc_message_id = $5 WHERE id = $1",
    [sendId, now, sent.id, sent.threadId, built.messageId],
  );
  return { outcome: "sent", mime: built.mime };
}

function appendFooterHtml(html: string, url: string, legal: string, postal: string): string {
  if (html.includes(url) && html.includes(postal)) return html;
  return `${html}<p>Unsubscribe: <a href="${url}">${url}</a></p><p>${legal}<br>${postal}</p>`;
}

async function contactFor(db: Db, normalized: string): Promise<string | null> {
  if (!normalized) return null;
  const result = await db.query<{ id: string }>("SELECT id FROM contacts WHERE normalized_email = $1", [normalized]);
  return result.rows[0]?.id ?? null;
}
