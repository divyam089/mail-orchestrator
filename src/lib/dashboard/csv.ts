import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

export type CsvView = "summary" | "by-inbox" | "by-campaign" | "by-day" | "funnel" | "health" | "alerts" | "caps";

export const CSV_VIEWS: CsvView[] = ["summary", "by-inbox", "by-campaign", "by-day", "funnel", "health", "alerts", "caps"];

function cell(value: unknown): string {
  const text = value == null || value === "" ? "" : String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  if (/[",\n\r]/.test(safe)) return `"${safe.replace(/"/g, '""')}"`;
  return safe;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(cell).join(","), ...rows.map((row) => row.map(cell).join(","))].join("\r\n") + "\r\n";
}

export function snapshotCsv(view: CsvView, data: DashboardSnapshot): string {
  if (view === "summary") {
    return toCsv(
      ["from", "to", "sent", "delivered", "hard_bounces", "soft_bounces", "replies", "positive_replies", "unsubscribes", "complaints", "opens", "clicks", "queue_ready", "queue_processing", "review_drafts", "fleet_used", "fleet_cap"],
      [[
        data.from,
        data.to,
        data.totals.sent,
        data.totals.delivered,
        data.totals.hardBounces,
        data.totals.softBounces,
        data.totals.replies,
        data.totals.positiveReplies,
        data.totals.unsubscribes,
        data.totals.complaints == null ? "no source" : data.totals.complaints,
        data.tracking.opens == null ? "tracking off" : data.tracking.opens,
        data.tracking.clicks == null ? "tracking off" : data.tracking.clicks,
        data.queue.ready == null ? "unavailable" : data.queue.ready,
        data.queue.processing == null ? "unavailable" : data.queue.processing,
        data.queue.reviewDrafts,
        data.caps.fleetUsed,
        data.caps.fleetCap,
      ]],
    );
  }
  if (view === "by-inbox") {
    return toCsv(
      ["inbox", "sent", "delivered", "hard_bounces", "soft_bounces", "replies", "positive_replies", "unsubscribes"],
      data.byInbox.map((row) => [row.email, row.sent, row.delivered, row.hardBounces, row.softBounces, row.replies, row.positiveReplies, row.unsubscribes]),
    );
  }
  if (view === "by-campaign") {
    return toCsv(
      ["campaign", "sent", "delivered", "hard_bounces", "soft_bounces", "replies", "positive_replies", "unsubscribes", "opens", "clicks", "tracking"],
      data.byCampaign.map((row) => [
        row.campaign,
        row.sent,
        row.delivered,
        row.hardBounces,
        row.softBounces,
        row.replies,
        row.positiveReplies,
        row.unsubscribes,
        row.opens == null ? "tracking off" : row.opens,
        row.clicks == null ? "tracking off" : row.clicks,
        row.tracking,
      ]),
    );
  }
  if (view === "by-day") {
    return toCsv(
      ["day", "sent", "hard_bounces", "soft_bounces", "replies", "unsubscribes"],
      data.byDay.map((row) => [row.day, row.sent, row.hardBounces, row.softBounces, row.replies, row.unsubscribes]),
    );
  }
  if (view === "funnel") {
    return toCsv(
      ["campaign", "step", "variant", "sent", "hard_bounces", "soft_bounces", "replies", "positive_replies", "unsubscribes"],
      data.funnel.map((row) => [row.campaign, row.step, row.variant, row.sent, row.hardBounces, row.softBounces, row.replies, row.positiveReplies, row.unsubscribes]),
    );
  }
  if (view === "caps") {
    return toCsv(
      ["inbox", "used_today", "ramp_cap", "ramp_day", "per_inbox_hard_max", "fleet_used", "fleet_cap", "fleet_hard_max", "ramp"],
      data.caps.inboxes.map((row) => [
        row.email,
        row.used,
        row.cap,
        row.rampDay,
        data.caps.perInboxHardMax,
        data.caps.fleetUsed,
        data.caps.fleetCap,
        data.caps.fleetHardMax,
        data.caps.ramp,
      ]),
    );
  }
  if (view === "health") {
    return toCsv(
      ["inbox", "status", "pause", "bounce_rate", "last_sync", "seed_placement", "warmup", "unsub_sync"],
      data.health.map((row) => [row.email, row.status, row.pause ?? "not paused", row.bounceRate, row.lastSync ?? "no sync yet", row.seedPlacement, row.warmup, data.unsubSync]),
    );
  }
  const rows = [
    ...data.alerts.disconnects.map((row) => ["disconnect", row.email ?? "", row.detail, row.at]),
    ...data.alerts.pauses.map((row) => ["pause", row.target, `${row.rule} ${row.detail ?? ""}`.trim(), row.at]),
    ...data.alerts.sync.filter((row) => row.state !== "fresh").map((row) => ["sync", row.email, row.state, row.lastSync ?? ""]),
    ...data.alerts.failedJobs.map((row) => ["failed_job", row.inbox, row.error ?? "", row.at]),
  ];
  return toCsv(["section", "target", "detail", "at"], rows);
}
