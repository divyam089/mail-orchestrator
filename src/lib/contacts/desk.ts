import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";

export type HoldItem = {
  id: string;
  email: string;
  verificationStatus: string;
  reason: string;
  campaignName: string | null;
  createdAt: string;
};

export type HoldDecisionItem = {
  id: string;
  email: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string;
};

export type ImportDesk = {
  verificationProvider: string;
  treatMxPassAsValid: boolean;
  pending: HoldItem[];
  recent: HoldDecisionItem[];
};

function stamp(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export async function loadImportDesk(db: Db = getPool()): Promise<ImportDesk> {
  const settings = await db.query<{ verification_provider: string; treat_mx_pass_as_valid: boolean }>(
    "SELECT verification_provider, treat_mx_pass_as_valid FROM app_settings WHERE id = 1",
  );
  const pending = await db.query<{
    id: string;
    email: string;
    verification_status: string;
    reason: string;
    campaign_name: string | null;
    created_at: Date;
  }>(
    `SELECT h.id, c.display_email AS email, h.verification_status, h.reason,
            camp.name AS campaign_name, h.created_at
     FROM verification_holds h
     JOIN contacts c ON c.id = h.contact_id
     LEFT JOIN campaigns camp ON camp.id = h.campaign_id
     WHERE h.status = 'pending'
     ORDER BY h.created_at DESC
     LIMIT 100`,
  );
  const recent = await db.query<{
    id: string;
    email: string;
    status: string;
    decided_by: string | null;
    decided_at: Date;
  }>(
    `SELECT h.id, c.display_email AS email, h.status, h.decided_by, h.decided_at
     FROM verification_holds h
     JOIN contacts c ON c.id = h.contact_id
     WHERE h.status IN ('approved', 'rejected') AND h.decided_at IS NOT NULL
     ORDER BY h.decided_at DESC
     LIMIT 8`,
  );
  const row = settings.rows[0];
  return {
    verificationProvider: row?.verification_provider ?? "TODO: verification provider",
    treatMxPassAsValid: row?.treat_mx_pass_as_valid ?? false,
    pending: pending.rows.map((item) => ({
      id: item.id,
      email: item.email,
      verificationStatus: item.verification_status,
      reason: item.reason,
      campaignName: item.campaign_name,
      createdAt: stamp(item.created_at),
    })),
    recent: recent.rows.map((item) => ({
      id: item.id,
      email: item.email,
      status: item.status,
      decidedBy: item.decided_by,
      decidedAt: stamp(item.decided_at),
    })),
  };
}
