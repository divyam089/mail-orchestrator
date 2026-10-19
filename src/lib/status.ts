import { cache } from "react";
import { anySendingPermitted, autoSendPermitted, readSendMode, readSendingEnabled, sendingBlockers, type ApprovalMode } from "@/lib/gates";
import { getPool } from "@/lib/db/pool";
import { redisPing } from "@/lib/redis";

export type InboxRow = {
  email: string;
  senderName: string;
  domain: string;
  status: string;
  dailyCap: number;
  provider: string;
};

export type SystemStatus = {
  ok: boolean;
  error: string | null;
  postgres: "up" | "down";
  redis: "up" | "down";
  migrationVersion: string | null;
  approvalMode: ApprovalMode | null;
  legalName: string | null;
  postalAddress: string | null;
  verificationProvider: string | null;
  unsubscribeHttpsBase: string | null;
  hosting: string | null;
  maxPerInbox: number | null;
  maxTotal: number | null;
  newPerInboxPerDay: number | null;
  ramp: string | null;
  sendingEnabled: boolean;
  sendMode: "dry-run" | "seed-only" | "live";
  blockers: string[];
  anySendingPermitted: boolean;
  autoSendPermitted: boolean;
  gmailKeyConfigured: boolean;
  inboxes: InboxRow[];
};

type SettingsRow = {
  approval_mode: ApprovalMode;
  legal_name: string;
  postal_address: string;
  verification_provider: string;
  unsubscribe_https_base: string;
  hosting: string;
  max_per_inbox: number;
  max_total: number;
  new_per_inbox_per_day: number;
  ramp: unknown;
};

type InboxSql = {
  email: string;
  sender_name: string;
  domain: string;
  status: string;
  daily_cap: number;
  provider: string;
};

function base(redis: "up" | "down"): SystemStatus {
  const sendingEnabled = readSendingEnabled();
  return {
    ok: false,
    error: null,
    postgres: "down",
    redis,
    migrationVersion: null,
    approvalMode: null,
    legalName: null,
    postalAddress: null,
    verificationProvider: null,
    unsubscribeHttpsBase: null,
    hosting: null,
    maxPerInbox: null,
    maxTotal: null,
    newPerInboxPerDay: null,
    ramp: null,
    sendingEnabled,
    sendMode: readSendMode(),
    blockers: sendingBlockers({
      sendingEnabled,
      legalName: "TODO: legal name",
      postalAddress: "TODO: postal address",
    }),
    anySendingPermitted: false,
    autoSendPermitted: false,
    gmailKeyConfigured: Boolean(process.env.GMAIL_SA_KEY_PATH?.trim()),
    inboxes: [],
  };
}

export const loadStatus = cache(async (): Promise<SystemStatus> => {
  const redis = (await redisPing()) ? "up" : "down";
  const status = base(redis);
  try {
    const pool = getPool();
    const [migration, settingsResult, inboxResult] = await Promise.all([
      pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"),
      pool.query<SettingsRow>(
        `SELECT approval_mode, legal_name, postal_address, verification_provider,
                unsubscribe_https_base, hosting, max_per_inbox, max_total,
                new_per_inbox_per_day, ramp
         FROM app_settings WHERE id = 1`,
      ),
      pool.query<InboxSql>(
        `SELECT email, sender_name, domain, status, daily_cap, provider
         FROM inboxes ORDER BY domain, email`,
      ),
    ]);
    const settings = settingsResult.rows[0];
    if (!settings) {
      status.error = "app_settings is missing. Seed did not run.";
      return status;
    }
    const blockers = sendingBlockers({
      sendingEnabled: status.sendingEnabled,
      legalName: settings.legal_name,
      postalAddress: settings.postal_address,
    });
    const gateInput = {
      sendingEnabled: status.sendingEnabled,
      legalName: settings.legal_name,
      postalAddress: settings.postal_address,
      approvalMode: settings.approval_mode,
    };
    return {
      ...status,
      ok: true,
      error: null,
      postgres: "up",
      migrationVersion: migration.rows[0]?.version ?? null,
      approvalMode: settings.approval_mode,
      legalName: settings.legal_name,
      postalAddress: settings.postal_address,
      verificationProvider: settings.verification_provider,
      unsubscribeHttpsBase: settings.unsubscribe_https_base,
      hosting: settings.hosting,
      maxPerInbox: settings.max_per_inbox,
      maxTotal: settings.max_total,
      newPerInboxPerDay: settings.new_per_inbox_per_day,
      ramp: JSON.stringify(settings.ramp),
      blockers,
      anySendingPermitted: anySendingPermitted(gateInput),
      autoSendPermitted: autoSendPermitted(gateInput),
      inboxes: inboxResult.rows.map((row) => ({
        email: row.email,
        senderName: row.sender_name,
        domain: row.domain,
        status: row.status,
        dailyCap: row.daily_cap,
        provider: row.provider,
      })),
    };
  } catch (error) {
    status.error = error instanceof Error ? error.message : "Database unreachable";
    return status;
  }
});
