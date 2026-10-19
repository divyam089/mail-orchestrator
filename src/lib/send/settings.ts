import type { ApprovalMode } from "@/lib/gates";
import type { RampStep } from "@/lib/caps";
import type { Db } from "@/lib/db/pool";
import { DEFAULT_WINDOW, type SendWindow } from "@/lib/window";

export type StopThresholds = {
  hardBouncePct: number;
  hardBounceWindow: number;
  complaintPausePct: number;
  complaintHardStopPct: number;
  seedMinInboxPct: number;
  unsubMaxHours: number;
};

export const DEFAULT_THRESHOLDS: StopThresholds = {
  hardBouncePct: 2,
  hardBounceWindow: 200,
  complaintPausePct: 0.1,
  complaintHardStopPct: 0.3,
  seedMinInboxPct: 80,
  unsubMaxHours: 24,
};

export type SendSettings = {
  approvalMode: ApprovalMode;
  legalName: string;
  postalAddress: string;
  unsubscribeHttpsBase: string;
  maxPerInbox: number;
  maxTotal: number;
  newPerInboxPerDay: number;
  ramp: RampStep[];
  window: SendWindow;
  thresholds: StopThresholds;
};

type SettingsSql = {
  approval_mode: ApprovalMode;
  legal_name: string;
  postal_address: string;
  unsubscribe_https_base: string;
  max_per_inbox: number;
  max_total: number;
  new_per_inbox_per_day: number;
  ramp: unknown;
  send_window: unknown;
  hard_bounce_pct: string;
  hard_bounce_window: number;
  complaint_pause_pct: string;
  complaint_hard_stop_pct: string;
  seed_min_inbox_pct: string;
  unsub_max_hours: number;
};

function asRamp(value: unknown): RampStep[] {
  if (!Array.isArray(value)) return [
    { days: 3, perInbox: 9 },
    { days: 4, perInbox: 18 },
    { days: null, perInbox: 27 },
  ];
  return value.map((step) => {
    const pair = step as [number | null, number];
    return { days: pair[0] == null ? null : Number(pair[0]), perInbox: Number(pair[1]) };
  });
}

function asWindow(value: unknown): SendWindow {
  if (!value || typeof value !== "object") return DEFAULT_WINDOW;
  const row = value as Record<string, string>;
  return {
    etStart: row.et_start || DEFAULT_WINDOW.etStart,
    etEnd: row.et_end || DEFAULT_WINDOW.etEnd,
    istStart: row.ist_start || DEFAULT_WINDOW.istStart,
    istEnd: row.ist_end || DEFAULT_WINDOW.istEnd,
  };
}

export async function loadSendSettings(db: Db): Promise<SendSettings> {
  const result = await db.query<SettingsSql>(
    `SELECT approval_mode, legal_name, postal_address, unsubscribe_https_base,
            max_per_inbox, max_total, new_per_inbox_per_day, ramp, send_window,
            hard_bounce_pct, hard_bounce_window, complaint_pause_pct, complaint_hard_stop_pct,
            seed_min_inbox_pct, unsub_max_hours
     FROM app_settings WHERE id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("app_settings is missing. Seed did not run.");
  return {
    approvalMode: row.approval_mode,
    legalName: row.legal_name,
    postalAddress: row.postal_address,
    unsubscribeHttpsBase: row.unsubscribe_https_base,
    maxPerInbox: row.max_per_inbox,
    maxTotal: row.max_total,
    newPerInboxPerDay: row.new_per_inbox_per_day,
    ramp: asRamp(row.ramp),
    window: asWindow(row.send_window),
    thresholds: {
      hardBouncePct: Number(row.hard_bounce_pct),
      hardBounceWindow: row.hard_bounce_window,
      complaintPausePct: Number(row.complaint_pause_pct),
      complaintHardStopPct: Number(row.complaint_hard_stop_pct),
      seedMinInboxPct: Number(row.seed_min_inbox_pct),
      unsubMaxHours: row.unsub_max_hours,
    },
  };
}

export function thresholdsLooser(next: StopThresholds, baseline: StopThresholds = DEFAULT_THRESHOLDS): boolean {
  return (
    next.hardBouncePct > baseline.hardBouncePct ||
    next.hardBounceWindow > baseline.hardBounceWindow ||
    next.complaintPausePct > baseline.complaintPausePct ||
    next.complaintHardStopPct > baseline.complaintHardStopPct ||
    next.seedMinInboxPct < baseline.seedMinInboxPct ||
    next.unsubMaxHours > baseline.unsubMaxHours
  );
}

export async function touchKv(db: Db, key: string, at: Date = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO app_kv (k, v, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [key, at.toISOString()],
  );
}

export async function readKvDate(db: Db, key: string): Promise<Date | null> {
  const result = await db.query<{ v: string }>("SELECT v FROM app_kv WHERE k = $1", [key]);
  const value = result.rows[0]?.v;
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function audit(
  db: Db,
  input: {
    source: "ui" | "api" | "system";
    actor: string;
    action: string;
    entityType?: string | null;
    entityId?: string | null;
    detail?: unknown;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (source, actor, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      input.source,
      input.actor,
      input.action,
      input.entityType ?? null,
      input.entityId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}
