import type { Db } from "@/lib/db/pool";
import { withOptionalTransaction } from "@/lib/db/tx";

export type HoldDecision = "approve" | "reject";

export type HoldActionResult =
  | { ok: true; status: "approved" | "rejected"; contactId: string; enrolled: boolean }
  | { ok: false; reason: "not_found" | "not_pending" };

type HoldRow = {
  id: string;
  contact_id: string;
  campaign_id: string | null;
  status: string;
  verification_status: string;
};

/**
 * Approve marks the contact valid and enrolls them when the hold names a campaign.
 * Reject leaves the verification status unchanged and does not enroll.
 * Both actions are written to audit_log.
 */
export async function decideHold(
  db: Db,
  input: {
    holdId: string;
    action: HoldDecision;
    actor: string;
    source: "ui" | "api" | "system";
  },
): Promise<HoldActionResult> {
  return withOptionalTransaction(db, async (tx) => {
    const found = await tx.query<HoldRow>(
      `SELECT id, contact_id, campaign_id, status, verification_status
       FROM verification_holds WHERE id = $1 FOR UPDATE`,
      [input.holdId],
    );
    const hold = found.rows[0];
    if (!hold) return { ok: false, reason: "not_found" };
    if (hold.status !== "pending") return { ok: false, reason: "not_pending" };

    let enrolled = false;
    if (input.action === "approve") {
      await tx.query("UPDATE contacts SET verification_status = 'valid', updated_at = now() WHERE id = $1", [
        hold.contact_id,
      ]);
      await tx.query(
        `INSERT INTO verification_results (contact_id, provider, status, syntax_ok, raw)
         VALUES ($1, 'manual', 'valid', true, $2::jsonb)`,
        [hold.contact_id, JSON.stringify({ action: "approve", actor: input.actor, holdId: hold.id })],
      );
      if (hold.campaign_id) {
        const enrollment = await tx.query(
          `INSERT INTO enrollments (campaign_id, contact_id)
           VALUES ($1, $2)
           ON CONFLICT (campaign_id, contact_id) DO NOTHING
           RETURNING id`,
          [hold.campaign_id, hold.contact_id],
        );
        enrolled = enrollment.rows.length > 0;
      }
      await tx.query(
        `UPDATE verification_holds
         SET status = 'approved', decided_at = now(), decided_by = $2
         WHERE id = $1`,
        [hold.id, input.actor],
      );
    } else {
      await tx.query(
        `UPDATE verification_holds
         SET status = 'rejected', decided_at = now(), decided_by = $2
         WHERE id = $1`,
        [hold.id, input.actor],
      );
    }

    await tx.query(
      `INSERT INTO audit_log (source, actor, action, entity_type, entity_id, detail)
       VALUES ($1, $2, $3, 'verification_hold', $4, $5::jsonb)`,
      [
        input.source,
        input.actor,
        input.action === "approve" ? "hold.approve" : "hold.reject",
        hold.id,
        JSON.stringify({
          contactId: hold.contact_id,
          campaignId: hold.campaign_id,
          previousStatus: hold.verification_status,
          enrolled,
        }),
      ],
    );

    return {
      ok: true,
      status: input.action === "approve" ? "approved" : "rejected",
      contactId: hold.contact_id,
      enrolled,
    };
  });
}
