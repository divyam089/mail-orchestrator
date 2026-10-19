import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";
import { readSendMode, readSendingEnabled, sendingBlockers, type ApprovalMode } from "@/lib/gates";
import { loadSendSettings } from "@/lib/send/settings";

export type ReviewItem = {
  id: string;
  state: string;
  stepNumber: number;
  subject: string;
  body: string;
  email: string;
  campaign: string;
  inbox: string | null;
  createdAt: string;
};

export type ReviewDesk = {
  approvalMode: ApprovalMode;
  sendingEnabled: boolean;
  sendMode: string;
  blockers: string[];
  drafts: ReviewItem[];
};

export async function loadReviewDesk(db: Db = getPool()): Promise<ReviewDesk> {
  const settings = await loadSendSettings(db);
  const sendingEnabled = readSendingEnabled();
  const result = await db.query<{
    id: string;
    state: string;
    step_number: number;
    subject: string;
    body: string;
    email: string;
    campaign: string;
    inbox: string | null;
    created_at: Date;
  }>(
    `SELECT d.id, d.state, d.step_number, d.subject, d.body,
            c.display_email AS email, camp.name AS campaign, i.email AS inbox, d.created_at
     FROM review_drafts d
     JOIN enrollments e ON e.id = d.enrollment_id
     JOIN contacts c ON c.id = e.contact_id
     JOIN campaigns camp ON camp.id = e.campaign_id
     LEFT JOIN inboxes i ON i.id = d.inbox_id
     WHERE d.state IN ('pending', 'edited', 'approved')
     ORDER BY d.created_at`,
  );
  return {
    approvalMode: settings.approvalMode,
    sendingEnabled,
    sendMode: readSendMode(),
    blockers: sendingBlockers({
      sendingEnabled,
      legalName: settings.legalName,
      postalAddress: settings.postalAddress,
    }),
    drafts: result.rows.map((row) => ({
      id: row.id,
      state: row.state,
      stepNumber: row.step_number,
      subject: row.subject,
      body: row.body,
      email: row.email,
      campaign: row.campaign,
      inbox: row.inbox,
      createdAt: row.created_at.toISOString().replace("T", " ").slice(0, 16) + " UTC",
    })),
  };
}
