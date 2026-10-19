import type { Db } from "@/lib/db/pool";
import { etDateISO } from "@/lib/window";
import {
  DEFAULT_THRESHOLDS,
  audit,
  loadSendSettings,
  readKvDate,
  thresholdsLooser,
  type StopThresholds,
} from "@/lib/send/settings";

export const PROVIDER_STOP_CODES = ["4.7.28", "5.7.515", "5.7.26"] as const;

export function providerStopCode(text: string | null | undefined): string | null {
  const value = text ?? "";
  for (const code of PROVIDER_STOP_CODES) {
    if (value.includes(code)) return code;
  }
  return null;
}

export async function pause(
  db: Db,
  input: { scope: "inbox" | "domain" | "fleet"; target: string; rule: string; detail: string; inboxId?: string | null },
): Promise<boolean> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO pauses (scope, target, rule, detail)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (scope, target, rule) WHERE resumed_at IS NULL DO NOTHING
     RETURNING id`,
    [input.scope, input.target, input.rule, input.detail],
  );
  if (!inserted.rows[0]) return false;
  await db.query("INSERT INTO alerts (kind, inbox_id, detail) VALUES ('pause', $1, $2)", [
    input.inboxId ?? null,
    `${input.rule} ${input.scope} ${input.target}: ${input.detail}`,
  ]);
  return true;
}

export async function inboxPaused(
  db: Db,
  inbox: { email: string; domain: string },
): Promise<{ rule: string; detail: string | null } | null> {
  const result = await db.query<{ rule: string; detail: string | null }>(
    `SELECT rule, detail FROM pauses
     WHERE resumed_at IS NULL
       AND (
         scope = 'fleet'
         OR (scope = 'inbox' AND target = $1)
         OR (scope = 'domain' AND target = $2)
       )
     ORDER BY paused_at
     LIMIT 1`,
    [inbox.email, inbox.domain],
  );
  return result.rows[0] ?? null;
}

async function bounceRate(
  db: Db,
  rows: { contact_id: string; inbox_id: string | null }[],
  inboxId: string | null,
): Promise<number> {
  if (rows.length === 0) return 0;
  const ids = rows.map((row) => row.contact_id);
  const result = await db.query<{ n: string }>(
    `SELECT COUNT(DISTINCT contact_id)::text AS n
     FROM events
     WHERE kind = 'hard_bounce'
       AND contact_id = ANY($1::uuid[])
       AND ($2::uuid IS NULL OR inbox_id = $2)`,
    [ids, inboxId],
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Hard bounce above the threshold. Per inbox there is no minimum sample. Fleet needs a full window. */
export async function hardBounceCheck(db: Db, thresholds: StopThresholds = DEFAULT_THRESHOLDS): Promise<string[]> {
  const fired: string[] = [];
  const inboxes = await db.query<{ id: string; email: string }>(
    `SELECT DISTINCT i.id, i.email
     FROM sends s
     JOIN inboxes i ON i.id = s.inbox_id
     WHERE s.kind = 'prospect' AND s.state = 'sent'`,
  );
  for (const inbox of inboxes.rows) {
    const rows = await db.query<{ contact_id: string }>(
      `SELECT contact_id FROM sends
       WHERE inbox_id = $1 AND kind = 'prospect' AND state = 'sent' AND contact_id IS NOT NULL
       ORDER BY reserved_at DESC
       LIMIT $2`,
      [inbox.id, thresholds.hardBounceWindow],
    );
    const n = rows.rows.length;
    if (n === 0) continue;
    const hb = await bounceRate(
      db,
      rows.rows.map((row) => ({ contact_id: row.contact_id, inbox_id: inbox.id })),
      inbox.id,
    );
    if ((hb * 100) / n > thresholds.hardBouncePct) {
      const created = await pause(db, {
        scope: "inbox",
        target: inbox.email,
        rule: "R2_hard_bounce",
        detail: `${hb}/${n} hard bounces = ${((hb * 100) / n).toFixed(2)}% (> ${thresholds.hardBouncePct}%)`,
        inboxId: inbox.id,
      });
      if (created) fired.push(inbox.email);
    }
  }

  const fleet = await db.query<{ contact_id: string }>(
    `SELECT contact_id FROM sends
     WHERE kind = 'prospect' AND state = 'sent' AND contact_id IS NOT NULL
     ORDER BY reserved_at DESC
     LIMIT $1`,
    [thresholds.hardBounceWindow],
  );
  if (fleet.rows.length >= thresholds.hardBounceWindow) {
    const hb = await bounceRate(
      db,
      fleet.rows.map((row) => ({ contact_id: row.contact_id, inbox_id: null })),
      null,
    );
    const n = fleet.rows.length;
    if ((hb * 100) / n > thresholds.hardBouncePct) {
      const created = await pause(db, {
        scope: "fleet",
        target: "*",
        rule: "R2_hard_bounce_fleet",
        detail: `${hb}/${n} = ${((hb * 100) / n).toFixed(2)}% (> ${thresholds.hardBouncePct}%)`,
      });
      if (created) fired.push("*");
    }
  }
  return fired;
}

/** Complaint rates are percent points: 0.10 means 0.10 percent of delivered mail. */
export async function complaintCheck(
  db: Db,
  input: { domain: string; complaints: number; delivered: number; source: string; thresholds?: StopThresholds },
): Promise<"hard_stop" | "pause" | null> {
  if (input.delivered <= 0) return null;
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  const rate = (input.complaints * 100) / input.delivered;
  if (rate >= thresholds.complaintHardStopPct) {
    await pause(db, {
      scope: "fleet",
      target: "*",
      rule: "R1_complaints_hard_stop",
      detail: `${input.domain}: ${input.complaints}/${input.delivered} = ${rate.toFixed(2)}% (>= ${thresholds.complaintHardStopPct}%) src=${input.source}`,
    });
    return "hard_stop";
  }
  if (rate >= thresholds.complaintPausePct) {
    await pause(db, {
      scope: "domain",
      target: input.domain,
      rule: "R1_complaints",
      detail: `${input.complaints}/${input.delivered} = ${rate.toFixed(2)}% (>= ${thresholds.complaintPausePct}%) src=${input.source}`,
    });
    return "pause";
  }
  return null;
}

export async function seedResult(
  db: Db,
  input: { inboxId: string; inboxEmail: string; inboxPct: number; report: string; thresholds?: StopThresholds; at?: Date },
): Promise<boolean> {
  const at = input.at ?? new Date();
  const thresholds = input.thresholds ?? DEFAULT_THRESHOLDS;
  await db.query(
    `INSERT INTO seed_tests (inbox_id, tested_at, et_date, inbox_placement_pct, report_ref, measurement, note)
     VALUES ($1, $2, $3, $4, $5, 'seed_test_only', 'Seed-test estimate only. Not measured on real recipients.')`,
    [input.inboxId, at, etDateISO(at), input.inboxPct, input.report],
  );
  await db.query(
    `INSERT INTO events (inbox_id, kind, detail, occurred_at, et_date)
     VALUES ($1, 'seed_result', $2::jsonb, $3, $4)`,
    [input.inboxId, JSON.stringify({ inbox_pct: input.inboxPct, report: input.report }), at, etDateISO(at)],
  );
  if (input.inboxPct < thresholds.seedMinInboxPct) {
    await pause(db, {
      scope: "inbox",
      target: input.inboxEmail,
      rule: "R3_seed_placement",
      detail: `${input.inboxPct}% inbox (< ${thresholds.seedMinInboxPct}%) ${input.report}`,
      inboxId: input.inboxId,
    });
    return true;
  }
  return false;
}

export async function blacklistHit(db: Db, input: { domain: string; listName: string; at?: Date }): Promise<void> {
  const at = input.at ?? new Date();
  await db.query(
    `INSERT INTO events (kind, detail, occurred_at, et_date)
     VALUES ('blacklist', $1::jsonb, $2, $3)`,
    [JSON.stringify({ domain: input.domain, list: input.listName }), at, etDateISO(at)],
  );
  await pause(db, {
    scope: "domain",
    target: input.domain,
    rule: "R4_blacklist",
    detail: `listed on ${input.listName}`,
  });
}

export async function unsubFreshness(
  db: Db,
  now: Date,
  maxHours: number,
): Promise<{ ok: boolean; reason: string }> {
  const last = await readKvDate(db, "unsub_sync_ok_at");
  if (!last) {
    return { ok: false, reason: "unsubscribe sync has never succeeded" };
  }
  const ageHours = (now.getTime() - last.getTime()) / 3_600_000;
  if (ageHours > maxHours) {
    return { ok: false, reason: `unsub sync stale (${ageHours.toFixed(1)} h > ${maxHours} h)` };
  }
  return { ok: true, reason: "ok" };
}

export async function pollFreshness(db: Db, now: Date, maxHours = 24): Promise<{ ok: boolean; reason: string }> {
  const last = await readKvDate(db, "poll_ok_at");
  if (!last) return { ok: false, reason: "reply/bounce poller has not succeeded in the last 24 h" };
  const ageHours = (now.getTime() - last.getTime()) / 3_600_000;
  if (ageHours > maxHours) {
    return { ok: false, reason: `reply/bounce poller stale (${ageHours.toFixed(1)} h > ${maxHours} h)` };
  }
  return { ok: true, reason: "ok" };
}

export async function updateStopThresholds(
  db: Db,
  input: {
    next: Partial<StopThresholds>;
    source: "ui" | "api" | "system";
    actor: string;
    reason?: string;
  },
): Promise<StopThresholds> {
  const current = (await loadSendSettings(db)).thresholds;
  const next: StopThresholds = { ...current, ...input.next };
  const looser = thresholdsLooser(next);
  if (looser && !input.reason?.trim()) {
    throw new Error("stop thresholds cannot be looser than defaults without an explicit reason");
  }
  let overrideId: string | null = null;
  if (looser) {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO threshold_overrides (source, actor, reason, previous, next)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id::text`,
      [input.source, input.actor, input.reason?.trim(), JSON.stringify(current), JSON.stringify(next)],
    );
    overrideId = inserted.rows[0].id;
    await audit(db, {
      source: input.source,
      actor: input.actor,
      action: "stop_threshold.override",
      entityType: "threshold_overrides",
      entityId: overrideId,
      detail: { previous: current, next, reason: input.reason?.trim() },
    });
  }
  await db.query(
    `UPDATE app_settings SET
       hard_bounce_pct = $1,
       hard_bounce_window = $2,
       complaint_pause_pct = $3,
       complaint_hard_stop_pct = $4,
       seed_min_inbox_pct = $5,
       unsub_max_hours = $6,
       stop_override_id = COALESCE($7::bigint, stop_override_id),
       updated_at = now()
     WHERE id = 1`,
    [
      next.hardBouncePct,
      next.hardBounceWindow,
      next.complaintPausePct,
      next.complaintHardStopPct,
      next.seedMinInboxPct,
      next.unsubMaxHours,
      overrideId,
    ],
  );
  return next;
}
