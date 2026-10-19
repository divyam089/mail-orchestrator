import type { MailAdapter, OutboundMessage } from "@/lib/mail/adapter";
import { MailSendRefused } from "@/lib/mail/adapter";
import { reserveSend } from "@/lib/sends/reserve";
import type { Db } from "@/lib/db/pool";
import { readSendMode, readSendingEnabled, type ApprovalMode } from "@/lib/gates";
import { effectiveApproval } from "@/lib/gates";
import { buildPlainMime, newMessageId, unsubscribeUrls } from "@/lib/send/mime";
import { evaluateSendGates, type GateAction } from "@/lib/send/gates";
import { loadSendSettings } from "@/lib/send/settings";
import { pause, providerStopCode } from "@/lib/send/stops";
import { composeMessage, looksLikeHtml, type Rng } from "@/lib/send/template";
import { etDateISO } from "@/lib/window";
import type { SendJob } from "@/lib/send/queue";

export type ExecuteHooks = {
  afterReserve?: () => Promise<void> | void;
  afterAdapter?: () => Promise<void> | void;
};

export type ExecuteResult = {
  outcome: "sent" | "deferred" | "skipped" | "already_locked" | "provider_stop" | "refused";
  reason?: string;
  sendId?: string;
};

type Loaded = {
  scheduleId: string;
  scheduleState: string;
  dueAt: Date;
  stepNumber: number;
  enrollmentId: string;
  enrollmentStatus: string;
  variant: string | null;
  threadId: string | null;
  lastRfc: string | null;
  referencesChain: string | null;
  firstSubject: string | null;
  unsubToken: string | null;
  contactId: string;
  displayEmail: string;
  verification: string;
  timezone: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  custom: Record<string, unknown>;
  campaignId: string;
  approvalOverride: ApprovalMode | null;
  trackOpens: boolean;
  trackClicks: boolean;
  inboxId: string;
  inboxEmail: string;
  inboxDomain: string;
  inboxStatus: string;
  senderName: string;
  draftId: string | null;
  draftState: string | null;
  draftSubject: string | null;
  draftBody: string | null;
};

async function loadJob(db: Db, scheduleId: string): Promise<Loaded | null> {
  const result = await db.query<{
    schedule_id: string;
    schedule_state: string;
    due_at: Date;
    step_number: number;
    enrollment_id: string;
    enrollment_status: string;
    variant: string | null;
    thread_id: string | null;
    last_rfc_message_id: string | null;
    references_chain: string | null;
    first_subject: string | null;
    unsub_token: string | null;
    contact_id: string;
    display_email: string;
    verification_status: string;
    timezone: string | null;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    title: string | null;
    custom_fields: unknown;
    campaign_id: string;
    approval_override: ApprovalMode | null;
    track_opens: boolean;
    track_clicks: boolean;
    inbox_id: string;
    inbox_email: string;
    inbox_domain: string;
    inbox_status: string;
    sender_name: string;
    draft_id: string | null;
    draft_state: string | null;
    draft_subject: string | null;
    draft_body: string | null;
  }>(
    `SELECT s.id AS schedule_id, s.state AS schedule_state, s.due_at, s.step_number,
            e.id AS enrollment_id, e.status AS enrollment_status, e.variant, e.thread_id,
            e.last_rfc_message_id, e.references_chain, e.first_subject, e.unsub_token,
            c.id AS contact_id, c.display_email, c.verification_status, c.timezone,
            c.first_name, c.last_name, c.company, c.title, c.custom_fields,
            camp.id AS campaign_id, camp.approval_override, camp.track_opens, camp.track_clicks,
            i.id AS inbox_id, i.email AS inbox_email, i.domain AS inbox_domain, i.status AS inbox_status,
            i.sender_name,
            d.id AS draft_id, d.state AS draft_state, d.subject AS draft_subject, d.body AS draft_body
     FROM schedule s
     JOIN enrollments e ON e.id = s.enrollment_id
     JOIN contacts c ON c.id = s.contact_id
     JOIN campaigns camp ON camp.id = s.campaign_id
     JOIN inboxes i ON i.id = s.inbox_id
     LEFT JOIN review_drafts d ON d.enrollment_id = e.id AND d.step_number = s.step_number
     WHERE s.id = $1`,
    [scheduleId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const custom =
    row.custom_fields && typeof row.custom_fields === "object" && !Array.isArray(row.custom_fields)
      ? (row.custom_fields as Record<string, unknown>)
      : {};
  return {
    scheduleId: row.schedule_id,
    scheduleState: row.schedule_state,
    dueAt: row.due_at,
    stepNumber: row.step_number,
    enrollmentId: row.enrollment_id,
    enrollmentStatus: row.enrollment_status,
    variant: row.variant,
    threadId: row.thread_id,
    lastRfc: row.last_rfc_message_id,
    referencesChain: row.references_chain,
    firstSubject: row.first_subject,
    unsubToken: row.unsub_token,
    contactId: row.contact_id,
    displayEmail: row.display_email,
    verification: row.verification_status,
    timezone: row.timezone,
    firstName: row.first_name,
    lastName: row.last_name,
    company: row.company,
    title: row.title,
    custom,
    campaignId: row.campaign_id,
    approvalOverride: row.approval_override,
    trackOpens: row.track_opens,
    trackClicks: row.track_clicks,
    inboxId: row.inbox_id,
    inboxEmail: row.inbox_email,
    inboxDomain: row.inbox_domain,
    inboxStatus: row.inbox_status,
    senderName: row.sender_name,
    draftId: row.draft_id,
    draftState: row.draft_state,
    draftSubject: row.draft_subject,
    draftBody: row.draft_body,
  };
}

async function existingSend(db: Db, contactId: string, campaignId: string, stepNumber: number): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM sends
     WHERE kind = 'prospect' AND contact_id = $1 AND campaign_id = $2 AND step_number = $3`,
    [contactId, campaignId, stepNumber],
  );
  return result.rows[0]?.id ?? null;
}

function mergeVars(row: Loaded, extra: Record<string, string | null>): Record<string, string | null> {
  const vars: Record<string, string | null> = {
    first_name: row.firstName,
    last_name: row.lastName,
    company: row.company,
    title: row.title,
    email: row.displayEmail,
    timezone: row.timezone,
    ...extra,
  };
  for (const [key, value] of Object.entries(row.custom)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") vars[key] = String(value);
  }
  return vars;
}

/**
 * One schedule row. Gates run before the reserve insert. An existing reserve,
 * in-flight, sent, or failed row never calls the adapter again.
 */
export async function executeSend(
  db: Db,
  job: SendJob,
  opts: {
    adapter: MailAdapter;
    now?: Date;
    sendingEnabled?: boolean;
    sendMode?: "dry-run" | "seed-only" | "live";
    holidays?: readonly string[];
    rng?: Rng;
    hooks?: ExecuteHooks;
    messageId?: string;
  },
): Promise<ExecuteResult> {
  const now = opts.now ?? new Date();
  const row = await loadJob(db, job.scheduleId);
  if (!row) return { outcome: "refused", reason: "schedule row is missing" };
  if (row.scheduleState === "sent" || row.scheduleState === "skipped") {
    return { outcome: "already_locked", reason: row.scheduleState };
  }
  const locked = await existingSend(db, row.contactId, row.campaignId, row.stepNumber);
  if (locked) return { outcome: "already_locked", sendId: locked, reason: "sent-log row already exists" };

  const settings = await loadSendSettings(db);
  const approval = effectiveApproval(settings.approvalMode, row.approvalOverride);
  if (approval === "review" && row.draftState !== "approved") {
    return { outcome: "deferred", reason: "approval is off; draft is waiting in Review" };
  }
  if (row.dueAt.getTime() > now.getTime()) {
    return { outcome: "deferred", reason: "not due yet" };
  }

  const sendingEnabled = opts.sendingEnabled ?? readSendingEnabled();
  const sendMode = opts.sendMode ?? readSendMode();
  const decision = await evaluateSendGates(db, {
    kind: "prospect",
    to: row.displayEmail,
    contactId: row.contactId,
    verificationStatus: row.verification,
    enrollmentStatus: row.enrollmentStatus,
    leadTimezone: row.timezone,
    inbox: { id: row.inboxId, email: row.inboxEmail, domain: row.inboxDomain, status: row.inboxStatus },
    now,
    sendingEnabled,
    sendMode,
    legalName: settings.legalName,
    postalAddress: settings.postalAddress,
    unsubscribeHttpsBase: settings.unsubscribeHttpsBase,
    maxPerInbox: settings.maxPerInbox,
    maxTotal: settings.maxTotal,
    ramp: settings.ramp,
    window: settings.window,
    thresholds: settings.thresholds,
    holidays: opts.holidays,
  });
  if (decision.action !== "send") return finishClosed(db, row, decision);

  const token = row.unsubToken ?? "missing-token";
  const urls = unsubscribeUrls(settings.unsubscribeHttpsBase, token, row.inboxEmail);
  let subject = row.draftState === "approved" ? (row.draftSubject ?? "") : "";
  let body = row.draftState === "approved" ? (row.draftBody ?? "") : "";
  if (row.draftState !== "approved") {
    const variant = await db.query<{ subject_template: string | null; body_template: string }>(
      `SELECT v.subject_template, v.body_template
       FROM sequence_steps s
       JOIN step_variants v ON v.step_id = s.id
       WHERE s.campaign_id = $1 AND s.step_number = $2 AND ($3::text IS NULL OR v.variant_key = $3)
       ORDER BY v.weight DESC
       LIMIT 1`,
      [row.campaignId, row.stepNumber, row.variant],
    );
    const chosen = variant.rows[0];
    if (!chosen) return finishClosed(db, row, { action: "skip", reason: "template is missing", stopReason: "missing_template" });
    const composed = composeMessage({
      subjectTemplate: chosen.subject_template,
      bodyTemplate: chosen.body_template,
      vars: mergeVars(row, {
        unsubscribe_url: urls.https,
        postal_address: settings.postalAddress,
        sender_name: row.senderName,
        unsub_token: token,
      }),
      stepNumber: row.stepNumber,
      firstSubject: row.firstSubject,
      unsubscribeUrl: urls.https,
      legalName: settings.legalName,
      postalAddress: settings.postalAddress,
      trackOpens: row.trackOpens,
      trackClicks: row.trackClicks,
      rng: opts.rng,
    });
    if (composed.missing.length > 0) {
      return finishClosed(db, row, { action: "defer", reason: `empty required merge field(s): ${composed.missing.join(", ")}` });
    }
    subject = composed.subject;
    body = composed.body;
  }
  if (looksLikeHtml(body)) {
    return finishClosed(db, row, { action: "skip", reason: "template looks like HTML; plain text only", stopReason: "html_template" });
  }
  if (!/unsubscribe/i.test(body) || !body.includes(settings.postalAddress)) {
    return finishClosed(db, row, { action: "defer", reason: "visible unsubscribe line or postal address is missing" });
  }

  const etDate = etDateISO(now);
  const reserved = await reserveSend(db, {
    contactId: row.contactId,
    campaignId: row.campaignId,
    enrollmentId: row.enrollmentId,
    stepNumber: row.stepNumber,
    variant: row.variant,
    inboxId: row.inboxId,
    etDate,
  });
  if (!reserved.ok) return { outcome: "already_locked", reason: "duplicate reserve" };
  await db.query("UPDATE sends SET state = 'sending' WHERE id = $1", [reserved.id]);
  if (row.draftId) {
    await db.query("UPDATE review_drafts SET send_id = $2 WHERE id = $1 AND send_id IS NULL", [row.draftId, reserved.id]);
  }
  await opts.hooks?.afterReserve?.();

  const domain = row.inboxEmail.split("@")[1] || "localhost";
  const built = buildPlainMime({
    fromEmail: row.inboxEmail,
    fromName: row.senderName,
    to: row.displayEmail,
    subject,
    body,
    messageId: opts.messageId ?? newMessageId(domain),
    date: now,
    inReplyTo: row.stepNumber > 1 ? row.lastRfc : null,
    references: row.stepNumber > 1 ? row.referencesChain : null,
    listUnsubscribeHttps: urls.https,
    listUnsubscribeMailto: urls.mailto,
  });
  const message: OutboundMessage = {
    from: row.inboxEmail,
    to: row.displayEmail,
    raw: built.raw,
    threadId: row.stepNumber > 1 ? (row.threadId ?? undefined) : undefined,
  };

  let sent: { id: string; threadId: string };
  try {
    sent = await deliverBehindGates(opts.adapter, { action: "send" }, message);
    await opts.hooks?.afterAdapter?.();
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const code = providerStopCode(text);
    if (code) {
      await db.query("UPDATE sends SET state = 'failed', error = $2 WHERE id = $1", [reserved.id, text.slice(0, 500)]);
      await db.query(
        `INSERT INTO events (inbox_id, contact_id, campaign_id, send_id, kind, detail, occurred_at, et_date)
         VALUES ($1, $2, $3, $4, 'provider_error', $5::jsonb, $6, $7)`,
        [row.inboxId, row.contactId, row.campaignId, reserved.id, JSON.stringify({ code, error: text.slice(0, 500) }), now, etDate],
      );
      await db.query("UPDATE schedule SET state = 'error' WHERE id = $1", [row.scheduleId]);
      await pause(db, {
        scope: "inbox",
        target: row.inboxEmail,
        rule: "R6_provider_error",
        detail: `${code}: ${text.slice(0, 300)}`,
        inboxId: row.inboxId,
      });
      return { outcome: "provider_stop", reason: code, sendId: reserved.id };
    }
    await db.query("UPDATE sends SET error = $2 WHERE id = $1", [reserved.id, text.slice(0, 500)]);
    throw error;
  }

  const references = [row.referencesChain, built.messageId].filter(Boolean).join(" ").trim();
  const nextStep = await db.query<{ n: string }>(
    "SELECT COUNT(*)::text AS n FROM sequence_steps WHERE campaign_id = $1 AND step_number > $2",
    [row.campaignId, row.stepNumber],
  );
  const done = Number(nextStep.rows[0]?.n ?? 0) === 0;
  await db.query(
    `UPDATE sends
     SET state = 'sent', sent_at = $2, gmail_id = $3, thread_id = $4, rfc_message_id = $5
     WHERE id = $1`,
    [reserved.id, now, sent.id, sent.threadId, built.messageId],
  );
  await db.query(
    `UPDATE enrollments SET
       status = $2,
       next_step = $3,
       thread_id = COALESCE(thread_id, $4),
       last_rfc_message_id = $5,
       references_chain = $6,
       first_subject = COALESCE(first_subject, $7),
       step1_et_date = COALESCE(step1_et_date, $8),
       updated_at = now()
     WHERE id = $1`,
    [
      row.enrollmentId,
      done ? "completed" : "active",
      done ? row.stepNumber : row.stepNumber + 1,
      sent.threadId,
      built.messageId,
      references,
      row.stepNumber === 1 ? subject : null,
      etDate,
    ],
  );
  await db.query("UPDATE schedule SET state = 'sent' WHERE id = $1", [row.scheduleId]);
  if (row.draftId) {
    await db.query(
      `UPDATE review_drafts SET state = 'sent', decided_at = COALESCE(decided_at, now()) WHERE id = $1`,
      [row.draftId],
    );
  }
  return { outcome: "sent", sendId: reserved.id };
}

async function finishClosed(db: Db, row: Loaded, decision: Exclude<GateAction, { action: "send" }>): Promise<ExecuteResult> {
  if (decision.action === "skip") {
    await db.query("UPDATE schedule SET state = 'skipped' WHERE id = $1 AND state IN ('planned', 'drafted')", [
      row.scheduleId,
    ]);
    if (decision.stopReason) {
      await db.query(
        `UPDATE enrollments SET status = 'stopped', stop_reason = $2, updated_at = now()
         WHERE id = $1 AND status IN ('pending', 'active')`,
        [row.enrollmentId, decision.stopReason],
      );
    }
    return { outcome: "skipped", reason: decision.reason };
  }
  return { outcome: "deferred", reason: decision.reason };
}

/** The only function that calls adapter.send. A closed gate throws before the call. */
export async function deliverBehindGates(
  adapter: MailAdapter,
  decision: { action: string },
  message: OutboundMessage,
): Promise<{ id: string; threadId: string }> {
  if (decision.action !== "send") {
    throw new MailSendRefused(`send refused before the adapter: ${decision.action}`);
  }
  return adapter.send(message);
}

export async function executeSeed(
  db: Db,
  input: {
    adapter: MailAdapter;
    inboxEmail: string;
    seedEmail: string;
    subject: string;
    body: string;
    now?: Date;
    sendingEnabled?: boolean;
    sendMode?: "dry-run" | "seed-only" | "live";
  },
): Promise<ExecuteResult> {
  const now = input.now ?? new Date();
  const settings = await loadSendSettings(db);
  const inbox = await db.query<{ id: string; email: string; domain: string; status: string; sender_name: string }>(
    "SELECT id, email, domain, status, sender_name FROM inboxes WHERE email = $1",
    [input.inboxEmail],
  );
  const found = inbox.rows[0];
  if (!found) return { outcome: "refused", reason: "inbox is missing" };
  const decision = await evaluateSendGates(db, {
    kind: "seed",
    to: input.seedEmail,
    contactId: null,
    verificationStatus: null,
    enrollmentStatus: null,
    leadTimezone: "America/New_York",
    inbox: found,
    now,
    sendingEnabled: input.sendingEnabled ?? readSendingEnabled(),
    sendMode: input.sendMode ?? readSendMode(),
    legalName: settings.legalName,
    postalAddress: settings.postalAddress,
    unsubscribeHttpsBase: settings.unsubscribeHttpsBase,
    maxPerInbox: settings.maxPerInbox,
    maxTotal: settings.maxTotal,
    ramp: settings.ramp,
    window: settings.window,
    thresholds: settings.thresholds,
  });
  if (decision.action !== "send") {
    return decision.action === "skip"
      ? { outcome: "skipped", reason: decision.reason }
      : { outcome: "deferred", reason: decision.reason };
  }
  const etDate = etDateISO(now);
  const reserved = await db.query<{ id: string }>(
    `INSERT INTO sends (inbox_id, kind, seed_address, step_number, et_date, state)
     VALUES ($1, 'seed', $2, 1, $3, 'reserved')
     ON CONFLICT (seed_address, inbox_id, step_number, et_date) WHERE kind = 'seed'
     DO NOTHING
     RETURNING id`,
    [found.id, input.seedEmail.trim().toLowerCase(), etDate],
  );
  const sendId = reserved.rows[0]?.id;
  if (!sendId) return { outcome: "already_locked", reason: "seed already reserved today" };
  const urls = unsubscribeUrls(settings.unsubscribeHttpsBase, `seed-${sendId}`, found.email);
  const built = buildPlainMime({
    fromEmail: found.email,
    fromName: found.sender_name,
    to: input.seedEmail,
    subject: input.subject,
    body: input.body.includes("Unsubscribe:")
      ? input.body
      : `${input.body}\n\nUnsubscribe: ${urls.https}\n\n${settings.legalName}\n${settings.postalAddress}\n`,
    date: now,
    listUnsubscribeHttps: urls.https,
    listUnsubscribeMailto: urls.mailto,
  });
  try {
    const sent = await deliverBehindGates(input.adapter, decision, {
      from: found.email,
      to: input.seedEmail,
      raw: built.raw,
    });
    await db.query(
      "UPDATE sends SET state = 'sent', sent_at = $2, gmail_id = $3, thread_id = $4, rfc_message_id = $5 WHERE id = $1",
      [sendId, now, sent.id, sent.threadId, built.messageId],
    );
    return { outcome: "sent", sendId };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (providerStopCode(text)) {
      await db.query("UPDATE sends SET state = 'failed', error = $2 WHERE id = $1", [sendId, text.slice(0, 500)]);
      await pause(db, {
        scope: "inbox",
        target: found.email,
        rule: "R6_provider_error",
        detail: text.slice(0, 300),
        inboxId: found.id,
      });
      return { outcome: "provider_stop", reason: text, sendId };
    }
    throw error;
  }
}
