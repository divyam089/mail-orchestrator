import type { Db } from "@/lib/db/pool";
import { normalizeEmail } from "@/lib/email/normalize";
import { classifyByRules } from "@/lib/mail/classify";
import { etDateISO } from "@/lib/window";

const BOUNCE_FROM = /^(mailer-daemon|postmaster)@/i;
const BOUNCE_TEXT = /delivery status notification|undeliverable|mail delivery failed/i;
const UNSUB = /\b(unsubscribe|remove me|opt[\s-]?out)\b/i;
const OOO = /\b(out of office|automatic reply|auto-reply|autoreply|away from the office)\b/i;
const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

export type InboundStop = {
  inboxId: string;
  gmailMessageId: string;
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  now?: Date;
};

async function stopContact(
  db: Db,
  input: { contactId: string; inboxId: string; gmailMessageId: string; kind: "reply" | "hard_bounce" | "unsubscribe" | "ooo"; reason: string; now: Date },
): Promise<void> {
  const etDate = etDateISO(input.now);
  await db.query(
    `INSERT INTO events (inbox_id, contact_id, kind, detail, gmail_message_id, occurred_at, et_date)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     ON CONFLICT (inbox_id, gmail_message_id, kind) WHERE gmail_message_id IS NOT NULL AND inbox_id IS NOT NULL
     DO NOTHING`,
    [input.inboxId, input.contactId, input.kind, JSON.stringify({ reason: input.reason }), input.gmailMessageId, input.now, etDate],
  );
  await db.query(
    `UPDATE enrollments
     SET status = 'stopped', stop_reason = $2, updated_at = now()
     WHERE contact_id = $1 AND status IN ('pending', 'active')`,
    [input.contactId, input.reason],
  );
  await db.query(
    `UPDATE schedule SET state = 'skipped'
     WHERE contact_id = $1 AND state IN ('planned', 'drafted')`,
    [input.contactId],
  );
}

async function contactId(db: Db, email: string): Promise<string | null> {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  const result = await db.query<{ id: string }>("SELECT id FROM contacts WHERE normalized_email = $1", [normalized]);
  return result.rows[0]?.id ?? null;
}

/**
 * Reply, hard bounce, unsubscribe, and out-of-office stop every open sequence
 * for that contact. No matching contact is a no-op so a mailbox sync can store
 * mail that is not part of a campaign.
 */
export async function stopFromInbound(db: Db, input: InboundStop): Promise<{ stopped: number }> {
  const now = input.now ?? new Date();
  const from = input.fromEmail?.trim().toLowerCase() ?? "";
  const blob = `${input.subject ?? ""}\n${input.bodyText ?? ""}`;
  let stopped = 0;

  if (BOUNCE_FROM.test(from) || BOUNCE_TEXT.test(blob)) {
    const seen = new Set<string>();
    for (const match of blob.matchAll(ADDRESS)) {
      const id = await contactId(db, match[0]);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await stopContact(db, {
        contactId: id,
        inboxId: input.inboxId,
        gmailMessageId: input.gmailMessageId,
        kind: "hard_bounce",
        reason: "hard_bounce",
        now,
      });
      stopped += 1;
    }
    return { stopped };
  }

  if (!from) return { stopped: 0 };
  const id = await contactId(db, from);
  if (!id) return { stopped: 0 };

  if (UNSUB.test(blob)) {
    const normalized = normalizeEmail(from);
    if (normalized) {
      await db.query(
        `INSERT INTO suppression (kind, value, reason, source)
         VALUES ('email', $1, 'unsubscribe reply', 'sync')
         ON CONFLICT (kind, value) DO NOTHING`,
        [normalized],
      );
    }
    await stopContact(db, {
      contactId: id,
      inboxId: input.inboxId,
      gmailMessageId: input.gmailMessageId,
      kind: "unsubscribe",
      reason: "unsubscribe",
      now,
    });
    await db.query(
      `UPDATE messages SET classification = 'unsubscribe'
       WHERE inbox_id = $1 AND gmail_message_id = $2`,
      [input.inboxId, input.gmailMessageId],
    );
    return { stopped: 1 };
  }

  if (OOO.test(blob)) {
    await stopContact(db, {
      contactId: id,
      inboxId: input.inboxId,
      gmailMessageId: input.gmailMessageId,
      kind: "ooo",
      reason: "ooo",
      now,
    });
    await db.query(
      `UPDATE messages SET classification = 'ooo'
       WHERE inbox_id = $1 AND gmail_message_id = $2`,
      [input.inboxId, input.gmailMessageId],
    );
    return { stopped: 1 };
  }

  await stopContact(db, {
    contactId: id,
    inboxId: input.inboxId,
    gmailMessageId: input.gmailMessageId,
    kind: "reply",
    reason: "reply",
    now,
  });
  const label = classifyByRules({ subject: input.subject, body: input.bodyText });
  if (label === "interested" || label === "not_now" || label === "not_interested") {
    await db.query(
      `UPDATE messages SET classification = $3 WHERE inbox_id = $1 AND gmail_message_id = $2`,
      [input.inboxId, input.gmailMessageId, label],
    );
  }
  return { stopped: 1 };
}
