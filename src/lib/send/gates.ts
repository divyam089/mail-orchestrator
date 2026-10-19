import { HARD_MAX_PER_INBOX, type RampStep } from "@/lib/caps";
import type { Db } from "@/lib/db/pool";
import { isUnset } from "@/lib/gates";
import { normalizeEmail } from "@/lib/email/normalize";
import { etDateISO, leadWindowAllows, type SendWindow } from "@/lib/window";
import { countingTowardCap, fleetCeiling, prospectInboxCap } from "@/lib/send/capacity";
import type { StopThresholds } from "@/lib/send/settings";
import { inboxPaused, pollFreshness, unsubFreshness } from "@/lib/send/stops";

export type GateAction =
  | { action: "send" }
  | { action: "defer"; reason: string }
  | { action: "skip"; reason: string; stopReason?: string };

export type GateSubject = {
  kind: "prospect" | "seed";
  to: string;
  contactId: string | null;
  verificationStatus: string | null;
  enrollmentStatus: string | null;
  leadTimezone: string | null;
  inbox: { id: string; email: string; domain: string; status: string };
  now: Date;
  sendingEnabled: boolean;
  sendMode: "dry-run" | "seed-only" | "live";
  legalName: string;
  postalAddress: string;
  unsubscribeHttpsBase: string;
  maxPerInbox: number;
  maxTotal: number;
  ramp: RampStep[];
  window: SendWindow;
  thresholds: StopThresholds;
  holidays?: readonly string[];
};

function domainCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().split(".");
  const candidates: string[] = [];
  for (let i = 0; i < labels.length - 1; i++) candidates.push(labels.slice(i).join("."));
  return candidates;
}

async function suppressed(db: Db, normalized: string): Promise<string | null> {
  const email = await db.query<{ reason: string }>(
    "SELECT reason FROM suppression WHERE kind = 'email' AND value = $1",
    [normalized],
  );
  if (email.rows[0]) return email.rows[0].reason;
  const domain = normalized.split("@")[1] ?? "";
  const candidates = domainCandidates(domain);
  if (candidates.length === 0) return null;
  const hit = await db.query<{ value: string; reason: string }>(
    "SELECT value, reason FROM suppression WHERE kind = 'domain' AND value = ANY($1::text[])",
    [candidates],
  );
  if (hit.rows[0]) return `domain ${hit.rows[0].value}: ${hit.rows[0].reason}`;
  return null;
}

async function inSeedTable(db: Db, normalized: string): Promise<boolean> {
  const result = await db.query("SELECT 1 FROM seed_addresses WHERE email = $1", [normalized]);
  return result.rows.length > 0;
}

/**
 * Every check here runs at send time. A defer leaves no sent-log row, so the
 * step can be tried later. A skip is permanent for that reason.
 */
export async function evaluateSendGates(db: Db, subject: GateSubject): Promise<GateAction> {
  if (subject.sendMode === "dry-run") return { action: "defer", reason: "dry-run mode: nothing is sent" };
  if (!subject.sendingEnabled) return { action: "defer", reason: "SENDING_ENABLED is not true" };
  if (isUnset(subject.legalName)) return { action: "defer", reason: "TODO: legal name" };
  if (isUnset(subject.postalAddress)) return { action: "defer", reason: "TODO: postal address" };
  if (isUnset(subject.unsubscribeHttpsBase)) return { action: "defer", reason: "TODO: unsubscribe url" };

  const normalized = normalizeEmail(subject.to);
  if (!normalized) return { action: "skip", reason: "contact address is not valid", stopReason: "invalid_address" };

  if (subject.sendMode === "seed-only") {
    const seed = subject.kind === "seed" && (await inSeedTable(db, normalized));
    if (!seed) return { action: "defer", reason: `seed-only mode: ${normalized} is not in seed_addresses` };
  }

  if (subject.kind === "prospect") {
    if (subject.verificationStatus !== "valid") {
      return { action: "defer", reason: `contact verification is ${subject.verificationStatus ?? "missing"}` };
    }
    if (subject.enrollmentStatus === "stopped" || subject.enrollmentStatus === "completed") {
      return { action: "skip", reason: `enrollment is ${subject.enrollmentStatus}`, stopReason: subject.enrollmentStatus };
    }
    const block = await suppressed(db, normalized);
    if (block) return { action: "skip", reason: `suppressed: ${block}`, stopReason: "suppressed" };
    const prior = await db.query<{ kind: string }>(
      `SELECT kind FROM events
       WHERE contact_id = $1 AND kind IN ('reply', 'hard_bounce', 'unsubscribe', 'ooo', 'opt_out_reply')
       LIMIT 1`,
      [subject.contactId],
    );
    if (prior.rows[0]) {
      return { action: "skip", reason: `contact already ${prior.rows[0].kind}`, stopReason: prior.rows[0].kind };
    }
    const window = leadWindowAllows(subject.now, subject.leadTimezone, subject.window, subject.holidays ?? []);
    if (!window.ok) return { action: "defer", reason: window.reason };
    const unsub = await unsubFreshness(db, subject.now, subject.thresholds.unsubMaxHours);
    if (!unsub.ok) return { action: "defer", reason: unsub.reason };
    const poll = await pollFreshness(db, subject.now, subject.thresholds.unsubMaxHours);
    if (!poll.ok) return { action: "defer", reason: poll.reason };
  }

  if (subject.inbox.status !== "active") {
    return { action: "defer", reason: `inbox ${subject.inbox.email} is ${subject.inbox.status}` };
  }
  const paused = await inboxPaused(db, subject.inbox);
  if (paused) return { action: "defer", reason: `inbox paused: ${paused.rule}` };

  const etDate = etDateISO(subject.now);
  const inboxCount = await countingTowardCap(db, etDate, subject.inbox.id);
  const fleetCount = await countingTowardCap(db, etDate);
  const inboxCap =
    subject.kind === "prospect"
      ? await prospectInboxCap(db, subject.inbox, etDate, subject.ramp, subject.maxPerInbox)
      : Math.min(subject.maxPerInbox, HARD_MAX_PER_INBOX);
  if (inboxCount >= inboxCap) return { action: "defer", reason: `per-inbox cap reached (${inboxCap}) for ${subject.inbox.email}` };
  const fleetCap = fleetCeiling(subject.maxTotal);
  if (fleetCount >= fleetCap) return { action: "defer", reason: `fleet cap reached (${fleetCap})` };
  return { action: "send" };
}
