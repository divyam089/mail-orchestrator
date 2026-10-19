import type { MailAdapter } from "@/lib/mail/adapter";
import type { Db } from "@/lib/db/pool";
import type { ApprovalMode } from "@/lib/gates";
import { executeSend, type ExecuteResult } from "@/lib/send/execute";
import { audit, loadSendSettings } from "@/lib/send/settings";
import type { Rng } from "@/lib/send/template";

export async function editDraft(
  db: Db,
  input: { id: string; subject: string; body: string; actor: string; source: "ui" | "api" | "system" },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const updated = await db.query(
    `UPDATE review_drafts
     SET subject = $2, body = $3, state = 'edited'
     WHERE id = $1 AND state IN ('pending', 'edited')`,
    [input.id, input.subject, input.body],
  );
  if ((updated.rowCount ?? 0) === 0) return { ok: false, reason: "draft is not editable" };
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "review.edit",
    entityType: "review_drafts",
    entityId: input.id,
  });
  return { ok: true };
}

export async function decideDraft(
  db: Db,
  input: {
    id: string;
    action: "approve" | "reject";
    actor: string;
    source: "ui" | "api" | "system";
    adapter?: MailAdapter;
    now?: Date;
    sendingEnabled?: boolean;
    sendMode?: "dry-run" | "seed-only" | "live";
    rng?: Rng;
  },
): Promise<{ ok: true; send?: ExecuteResult } | { ok: false; reason: string }> {
  const draft = await db.query<{
    id: string;
    enrollment_id: string | null;
    step_number: number;
    state: string;
    kind: string;
  }>("SELECT id, enrollment_id, step_number, state, kind FROM review_drafts WHERE id = $1", [input.id]);
  const row = draft.rows[0];
  if (!row) return { ok: false, reason: "draft not found" };
  if (row.state === "sent" || row.state === "rejected") return { ok: false, reason: `draft is ${row.state}` };

  if (row.kind === "manual" || !row.enrollment_id) {
    const next = input.action === "reject" ? "rejected" : "approved";
    await db.query(
      `UPDATE review_drafts SET state = $2, decided_at = now(), decided_by = $3 WHERE id = $1`,
      [row.id, next, input.actor],
    );
    await audit(db, {
      source: input.source,
      actor: input.actor,
      action: input.action === "reject" ? "review.reject" : "review.approve",
      entityType: "review_drafts",
      entityId: row.id,
      detail: { kind: "manual" },
    });
    return { ok: true };
  }

  if (input.action === "reject") {
    await db.query(
      `UPDATE review_drafts SET state = 'rejected', decided_at = now(), decided_by = $2 WHERE id = $1`,
      [row.id, input.actor],
    );
    await db.query(
      `UPDATE schedule SET state = 'skipped'
       WHERE enrollment_id = $1 AND step_number = $2 AND state IN ('planned', 'drafted')`,
      [row.enrollment_id, row.step_number],
    );
    await db.query(
      `UPDATE enrollments SET status = 'stopped', stop_reason = 'review_rejected', updated_at = now()
       WHERE id = $1 AND status IN ('pending', 'active')`,
      [row.enrollment_id],
    );
    await audit(db, {
      source: input.source,
      actor: input.actor,
      action: "review.reject",
      entityType: "review_drafts",
      entityId: row.id,
    });
    return { ok: true };
  }

  await db.query(
    `UPDATE review_drafts
     SET state = 'approved', decided_at = now(), decided_by = $2
     WHERE id = $1 AND state IN ('pending', 'edited', 'approved')`,
    [row.id, input.actor],
  );
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "review.approve",
    entityType: "review_drafts",
    entityId: row.id,
    detail: { step: row.step_number },
  });
  const schedule = await db.query<{ id: string }>(
    `SELECT id FROM schedule WHERE enrollment_id = $1 AND step_number = $2 AND state IN ('drafted', 'planned')`,
    [row.enrollment_id, row.step_number],
  );
  const scheduleId = schedule.rows[0]?.id;
  if (!scheduleId || !input.adapter) return { ok: true };
  const send = await executeSend(db, { scheduleId }, {
    adapter: input.adapter,
    now: input.now,
    sendingEnabled: input.sendingEnabled,
    sendMode: input.sendMode,
    rng: input.rng,
  });
  return { ok: true, send };
}

export async function bulkDecide(
  db: Db,
  input: {
    ids: string[];
    action: "approve" | "reject";
    actor: string;
    source: "ui" | "api" | "system";
    adapter?: MailAdapter;
    now?: Date;
    sendingEnabled?: boolean;
    sendMode?: "dry-run" | "seed-only" | "live";
  },
): Promise<{ id: string; ok: boolean; reason?: string; send?: ExecuteResult }[]> {
  const results = [];
  for (const id of input.ids) {
    const result = await decideDraft(db, { ...input, id });
    if (result.ok) results.push({ id, ok: true, send: result.send });
    else results.push({ id, ok: false, reason: result.reason });
  }
  return results;
}

export async function setApprovalMode(
  db: Db,
  input: {
    scope: "global" | "campaign";
    mode: ApprovalMode;
    campaignId?: string;
    source: "ui" | "api" | "system";
    actor: string;
  },
): Promise<{ changed: boolean; mode: ApprovalMode }> {
  if (input.scope === "global") {
    const current = await loadSendSettings(db);
    if (current.approvalMode === input.mode) return { changed: false, mode: input.mode };
    await db.query("UPDATE app_settings SET approval_mode = $1, updated_at = now() WHERE id = 1", [input.mode]);
    await audit(db, {
      source: input.source,
      actor: input.actor,
      action: "approval.change",
      entityType: "app_settings",
      entityId: "1",
      detail: { scope: "global", from: current.approvalMode, to: input.mode },
    });
    return { changed: true, mode: input.mode };
  }
  if (!input.campaignId) throw new Error("campaignId is required");
  const current = await db.query<{ approval_override: ApprovalMode | null }>(
    "SELECT approval_override FROM campaigns WHERE id = $1",
    [input.campaignId],
  );
  const previous = current.rows[0]?.approval_override ?? null;
  if (!current.rows[0]) throw new Error("campaign not found");
  if (previous === input.mode) return { changed: false, mode: input.mode };
  await db.query("UPDATE campaigns SET approval_override = $2, updated_at = now() WHERE id = $1", [
    input.campaignId,
    input.mode,
  ]);
  await audit(db, {
    source: input.source,
    actor: input.actor,
    action: "approval.change",
    entityType: "campaigns",
    entityId: input.campaignId,
    detail: { scope: "campaign", from: previous, to: input.mode },
  });
  return { changed: true, mode: input.mode };
}
