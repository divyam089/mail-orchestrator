import { effectiveApproval, type ApprovalMode } from "@/lib/gates";
import type { Db } from "@/lib/db/pool";
import { countingTowardCap, fleetCeiling, prospectInboxCap } from "@/lib/send/capacity";
import type { SendQueue } from "@/lib/send/queue";
import { loadSendSettings } from "@/lib/send/settings";
import { inboxPaused } from "@/lib/send/stops";
import { composeMessage, type Rng } from "@/lib/send/template";
import { newUnsubToken, unsubscribeUrls } from "@/lib/send/mime";
import { etWindowBounds, isUsBusinessDay, addBusinessDays, leadWindowAllows } from "@/lib/window";

const MARGIN_MS = 10 * 60 * 1000;

export type PlanSummary = {
  etDate: string;
  planned: number;
  drafted: number;
  notes: string[];
};

type InboxRow = { id: string; email: string; domain: string; sender_name: string; status: string };

type Candidate = {
  enrollmentId: string;
  campaignId: string;
  contactId: string;
  status: string;
  variant: string | null;
  inboxId: string | null;
  nextStep: number;
  step1: string | null;
  firstSubject: string | null;
  unsubToken: string | null;
  displayEmail: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  title: string | null;
  timezone: string | null;
  custom: Record<string, unknown>;
  approvalOverride: ApprovalMode | null;
  trackOpens: boolean;
  trackClicks: boolean;
  delay: number;
};

type Variant = { key: string; subject: string | null; body: string; weight: number };

function shuffle<T>(items: T[], rng: Rng): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const left = copy[i];
    copy[i] = copy[j] as T;
    copy[j] = left as T;
  }
  return copy;
}

function pickWeighted(variants: Variant[], rng: Rng): Variant {
  const total = variants.reduce((sum, variant) => sum + variant.weight, 0);
  let mark = rng() * total;
  for (const variant of variants) {
    mark -= variant.weight;
    if (mark < 0) return variant;
  }
  return variants[variants.length - 1] as Variant;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringVars(row: Candidate, extra: Record<string, string | null>): Record<string, string | null> {
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
    if (value == null) vars[key] = null;
    else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") vars[key] = String(value);
  }
  return vars;
}

async function loadVariants(db: Db, campaignId: string, stepNumber: number): Promise<{ delay: number; variants: Variant[] } | null> {
  const result = await db.query<{
    delay_business_days: number;
    variant_key: string;
    subject_template: string | null;
    body_template: string;
    weight: number;
  }>(
    `SELECT s.delay_business_days, v.variant_key, v.subject_template, v.body_template, v.weight
     FROM sequence_steps s
     JOIN step_variants v ON v.step_id = s.id
     WHERE s.campaign_id = $1 AND s.step_number = $2
     ORDER BY v.variant_key`,
    [campaignId, stepNumber],
  );
  if (result.rows.length === 0) return null;
  return {
    delay: result.rows[0].delay_business_days,
    variants: result.rows.map((row) => ({
      key: row.variant_key,
      subject: row.subject_template,
      body: row.body_template,
      weight: row.weight,
    })),
  };
}

function validMinutes(
  etDate: string,
  now: Date,
  leadTimezone: string | null,
  window: PlanContext["window"],
  holidays: readonly string[],
): Date[] {
  const bounds = etWindowBounds(etDate, window);
  const end = bounds.end.getTime() - MARGIN_MS;
  const start = Math.max(bounds.start.getTime(), now.getTime());
  const minutes: Date[] = [];
  for (let cursor = start; cursor < end; cursor += 60_000) {
    const at = new Date(cursor);
    if (leadWindowAllows(at, leadTimezone, window, holidays).ok) minutes.push(at);
  }
  return minutes;
}

type PlanContext = Awaited<ReturnType<typeof loadSendSettings>>;

/**
 * Builds one Eastern day's schedule. Follow-ups first, then new prospects,
 * sticky inbox, round-robin across inboxes with room. Review mode writes
 * drafts and does not enqueue. This function never sends.
 */
export async function planDay(
  db: Db,
  input: { etDate: string; now: Date; holidays?: readonly string[]; rng?: Rng; queue?: SendQueue },
): Promise<PlanSummary> {
  const rng = input.rng ?? Math.random;
  const holidays = input.holidays ?? [];
  const settings = await loadSendSettings(db);
  const summary: PlanSummary = { etDate: input.etDate, planned: 0, drafted: 0, notes: [] };
  if (!isUsBusinessDay(input.etDate, holidays)) {
    summary.notes.push(`${input.etDate} is not a US business day: no sends`);
    return summary;
  }
  const existing = await db.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM schedule WHERE et_date = $1", [
    input.etDate,
  ]);
  if (Number(existing.rows[0]?.n ?? 0) > 0) {
    summary.notes.push(`schedule for ${input.etDate} already existed; not re-planned`);
    return summary;
  }
  const bounds = etWindowBounds(input.etDate, settings.window);
  if (input.now.getTime() >= bounds.end.getTime() - MARGIN_MS) {
    summary.notes.push(`send window for ${input.etDate} is over: nothing planned`);
    return summary;
  }

  const inboxes = await db.query<InboxRow>(
    `SELECT id, email, domain, sender_name, status FROM inboxes WHERE status = 'active' ORDER BY email`,
  );
  const open: InboxRow[] = [];
  for (const inbox of inboxes.rows) {
    const paused = await inboxPaused(db, inbox);
    if (!paused) open.push(inbox);
  }
  if (open.length === 0) {
    summary.notes.push("no active unpaused inbox");
    return summary;
  }

  const enrolled = await db.query<{
    id: string;
    campaign_id: string;
    contact_id: string;
    status: string;
    variant: string | null;
    inbox_id: string | null;
    next_step: number;
    step1_et_date: string | null;
    first_subject: string | null;
    unsub_token: string | null;
    display_email: string;
    first_name: string | null;
    last_name: string | null;
    company: string | null;
    title: string | null;
    timezone: string | null;
    custom_fields: unknown;
    approval_override: ApprovalMode | null;
    track_opens: boolean;
    track_clicks: boolean;
  }>(
    `SELECT e.id, e.campaign_id, e.contact_id, e.status, e.variant, e.inbox_id, e.next_step,
            e.step1_et_date::text, e.first_subject, e.unsub_token,
            c.display_email, c.first_name, c.last_name, c.company, c.title, c.timezone, c.custom_fields,
            camp.approval_override, camp.track_opens, camp.track_clicks
     FROM enrollments e
     JOIN contacts c ON c.id = e.contact_id
     JOIN campaigns camp ON camp.id = e.campaign_id
     WHERE e.status IN ('pending', 'active')
       AND camp.status = 'active'
       AND c.verification_status = 'valid'
       AND NOT EXISTS (
         SELECT 1 FROM schedule s
         WHERE s.enrollment_id = e.id
           AND s.step_number = e.next_step
           AND s.state IN ('planned', 'drafted')
       )
     ORDER BY e.created_at, c.normalized_email`,
  );

  const due: Candidate[] = [];
  for (const row of enrolled.rows) {
    const step = await loadVariants(db, row.campaign_id, row.next_step);
    if (!step) continue;
    const step1 = row.step1_et_date;
    if (row.next_step === 1) {
      if (step1 && step1 > input.etDate) continue;
    } else {
      if (!step1) continue;
      const ready = addBusinessDays(step1, step.delay, holidays);
      if (ready > input.etDate) continue;
    }
    due.push({
      enrollmentId: row.id,
      campaignId: row.campaign_id,
      contactId: row.contact_id,
      status: row.status,
      variant: row.variant,
      inboxId: row.inbox_id,
      nextStep: row.next_step,
      step1,
      firstSubject: row.first_subject,
      unsubToken: row.unsub_token,
      displayEmail: row.display_email,
      firstName: row.first_name,
      lastName: row.last_name,
      company: row.company,
      title: row.title,
      timezone: row.timezone,
      custom: asRecord(row.custom_fields),
      approvalOverride: row.approval_override,
      trackOpens: row.track_opens,
      trackClicks: row.track_clicks,
      delay: step.delay,
    });
  }

  const followups = due.filter((row) => row.nextStep > 1);
  const fresh = due.filter((row) => row.nextStep === 1);
  const room = new Map<string, number>();
  const roomNew = new Map<string, number>();
  let budget = fleetCeiling(settings.maxTotal) - (await countingTowardCap(db, input.etDate));
  const assigned = new Map<string, Candidate[]>();

  for (const inbox of open) {
    const cap = await prospectInboxCap(db, inbox, input.etDate, settings.ramp, settings.maxPerInbox);
    const already = await countingTowardCap(db, input.etDate, inbox.id);
    const left = Math.max(0, Math.min(cap - already, budget));
    const mine = followups.filter((row) => row.inboxId === inbox.id);
    const taken = mine.slice(0, left);
    assigned.set(inbox.id, taken);
    room.set(inbox.id, left - taken.length);
    roomNew.set(inbox.id, Math.max(0, Math.min(room.get(inbox.id) ?? 0, settings.newPerInboxPerDay)));
    budget -= taken.length;
  }

  const inboxById = new Map(open.map((inbox) => [inbox.id, inbox]));
  const sticky = fresh.filter((row) => row.inboxId && inboxById.has(row.inboxId));
  const free = fresh.filter((row) => !row.inboxId || !inboxById.has(row.inboxId ?? ""));
  for (const row of sticky) {
    const id = row.inboxId as string;
    if ((roomNew.get(id) ?? 0) > 0 && budget > 0) {
      assigned.get(id)?.push(row);
      roomNew.set(id, (roomNew.get(id) ?? 0) - 1);
      budget -= 1;
    }
  }
  let order = open.filter((inbox) => (roomNew.get(inbox.id) ?? 0) > 0);
  let cursor = 0;
  for (const row of free) {
    order = order.filter((inbox) => (roomNew.get(inbox.id) ?? 0) > 0);
    if (order.length === 0 || budget <= 0) {
      if (budget <= 0) summary.notes.push("fleet cap reached while assigning new prospects");
      break;
    }
    const inbox = order[cursor % order.length] as InboxRow;
    cursor += 1;
    row.inboxId = inbox.id;
    assigned.get(inbox.id)?.push(row);
    roomNew.set(inbox.id, (roomNew.get(inbox.id) ?? 0) - 1);
    budget -= 1;
  }

  for (const inbox of open) {
    const rows = shuffle(assigned.get(inbox.id) ?? [], rng);
    if (rows.length === 0) continue;
    let placed = 0;
    for (const row of rows) {
      const minutes = validMinutes(input.etDate, input.now, row.timezone, settings.window, holidays);
      if (minutes.length === 0) {
        summary.notes.push(`${row.displayEmail} has no overlap between local hours and the ET window`);
        continue;
      }
      const span = minutes.length / rows.length;
      const start = Math.min(minutes.length - 1, Math.floor(placed * span));
      const end = Math.min(minutes.length, Math.max(start + 1, Math.floor((placed + 1) * span)));
      const slice = minutes.slice(start, end);
      const dueAt = slice[Math.floor(rng() * slice.length)] ?? minutes[start];
      placed += 1;
      const step = await loadVariants(db, row.campaignId, row.nextStep);
      if (!step) continue;
      const chosen = row.variant ? (step.variants.find((variant) => variant.key === row.variant) ?? pickWeighted(step.variants, rng)) : pickWeighted(step.variants, rng);
      const token = row.unsubToken ?? newUnsubToken();
      const urls = unsubscribeUrls(settings.unsubscribeHttpsBase, token, inbox.email);
      const composed = composeMessage({
        subjectTemplate: chosen.subject,
        bodyTemplate: chosen.body,
        vars: stringVars(row, {
          unsubscribe_url: urls.https,
          postal_address: settings.postalAddress,
          sender_name: inbox.sender_name,
          unsub_token: token,
        }),
        stepNumber: row.nextStep,
        firstSubject: row.firstSubject,
        unsubscribeUrl: urls.https,
        legalName: settings.legalName,
        postalAddress: settings.postalAddress,
        trackOpens: row.trackOpens,
        trackClicks: row.trackClicks,
        rng,
      });
      await db.query(
        `UPDATE enrollments
         SET inbox_id = $2, variant = $3, unsub_token = $4, status = 'active', updated_at = now()
         WHERE id = $1`,
        [row.enrollmentId, inbox.id, chosen.key, token],
      );
      const mode = effectiveApproval(settings.approvalMode, row.approvalOverride);
      const schedule = await db.query<{ id: string }>(
        `INSERT INTO schedule (et_date, inbox_id, contact_id, campaign_id, enrollment_id, step_number, due_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (et_date, contact_id, campaign_id, step_number) DO NOTHING
         RETURNING id`,
        [
          input.etDate,
          inbox.id,
          row.contactId,
          row.campaignId,
          row.enrollmentId,
          row.nextStep,
          dueAt,
          mode === "review" ? "drafted" : "planned",
        ],
      );
      const scheduleId = schedule.rows[0]?.id;
      if (!scheduleId) continue;
      if (mode === "review") {
        await db.query(
          `INSERT INTO review_drafts (enrollment_id, step_number, subject, body, inbox_id, state)
           VALUES ($1, $2, $3, $4, $5, 'pending')
           ON CONFLICT (enrollment_id, step_number) DO NOTHING`,
          [row.enrollmentId, row.nextStep, composed.subject || "(no subject)", composed.body, inbox.id],
        );
        summary.drafted += 1;
      } else {
        summary.planned += 1;
        if (input.queue) await input.queue.push({ scheduleId });
      }
    }
  }
  return summary;
}
