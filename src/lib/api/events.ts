import type { Db } from "@/lib/db/pool";
import type { DashboardEvent } from "@/lib/dashboard/listen";

/** Maps a ledger notification onto the assistant event names. Other rows are dropped. */
export async function presentApiEvent(
  db: Db,
  event: DashboardEvent,
): Promise<{ name: string; data: unknown } | null> {
  if (event.entity === "events" && event.entityId) {
    const row = await db.query<{ kind: string; inbox_id: string | null; campaign_id: string | null }>(
      `SELECT kind, inbox_id::text, campaign_id::text FROM events WHERE id = $1`,
      [event.entityId],
    );
    const kind = row.rows[0]?.kind;
    if (kind === "reply") {
      return { name: "reply.received", data: { id: event.entityId, inboxId: row.rows[0].inbox_id, campaignId: row.rows[0].campaign_id } };
    }
    if (kind === "hard_bounce" || kind === "soft_bounce") {
      return { name: "bounce", data: { id: event.entityId, kind, inboxId: row.rows[0].inbox_id } };
    }
    return null;
  }
  if (event.entity === "pauses" && event.op === "INSERT" && event.entityId) {
    const row = await db.query<{ scope: string; target: string; rule: string }>(
      `SELECT scope, target, rule FROM pauses WHERE id = $1 AND resumed_at IS NULL`,
      [event.entityId],
    );
    if (!row.rows[0]) return null;
    return { name: "inbox.paused", data: { id: event.entityId, ...row.rows[0] } };
  }
  if (event.entity === "review_drafts" && event.op === "INSERT" && event.entityId) {
    const row = await db.query<{ state: string; kind: string }>(
      `SELECT state, kind FROM review_drafts WHERE id = $1`,
      [event.entityId],
    );
    if (!row.rows[0] || (row.rows[0].state !== "pending" && row.rows[0].state !== "edited")) return null;
    return { name: "draft.awaiting_review", data: { id: event.entityId, kind: row.rows[0].kind, state: row.rows[0].state } };
  }
  return null;
}
