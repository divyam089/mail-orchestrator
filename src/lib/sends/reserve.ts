import type { Db } from "@/lib/db/pool";

export type ReserveResult = { ok: true; id: string } | { ok: false; reason: "duplicate" };

/**
 * Inserts the sent-log row before any network call. The unique index
 * (contact, campaign, step) makes a second insert a no-op, so a retry or a
 * crash restart cannot send that step again.
 */
export async function reserveSend(
  db: Db,
  input: {
    contactId: string;
    campaignId: string;
    enrollmentId?: string | null;
    stepNumber: number;
    variant?: string | null;
    inboxId: string;
    etDate: string;
  },
): Promise<ReserveResult> {
  const result = await db.query<{ id: string }>(
    `INSERT INTO sends (
       contact_id, campaign_id, enrollment_id, step_number, variant, inbox_id, kind, et_date, state
     ) VALUES ($1, $2, $3, $4, $5, $6, 'prospect', $7, 'reserved')
     ON CONFLICT (contact_id, campaign_id, step_number) WHERE kind = 'prospect'
     DO NOTHING
     RETURNING id`,
    [
      input.contactId,
      input.campaignId,
      input.enrollmentId ?? null,
      input.stepNumber,
      input.variant ?? null,
      input.inboxId,
      input.etDate,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) return { ok: false, reason: "duplicate" };
  return { ok: true, id };
}
