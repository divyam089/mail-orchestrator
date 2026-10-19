import { HARD_MAX_PER_INBOX, HARD_MAX_TOTAL } from "@/lib/caps";
import type { Db } from "@/lib/db/pool";
import { SEND_QUEUE_PROCESSING, SEND_QUEUE_READY } from "@/lib/send/queue";
import { countingTowardCap, fleetCeiling, prospectInboxCap } from "@/lib/send/capacity";
import { loadSendSettings } from "@/lib/send/settings";
import { etDateISO } from "@/lib/window";
import Redis from "ioredis";

export type DashboardRange = { from: string; to: string };

export type CountCell = number;

export type InboxMetric = {
  email: string;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  replies: number;
  positiveReplies: number;
  unsubscribes: number;
};

export type CampaignMetric = {
  campaign: string;
  sent: number;
  delivered: number;
  hardBounces: number;
  softBounces: number;
  replies: number;
  positiveReplies: number;
  unsubscribes: number;
  opens: number | null;
  clicks: number | null;
  tracking: string;
};

export type DayMetric = { day: string; sent: number; hardBounces: number; softBounces: number; replies: number; unsubscribes: number };

export type FunnelRow = {
  campaign: string;
  step: number;
  variant: string;
  sent: number;
  hardBounces: number;
  softBounces: number;
  replies: number;
  positiveReplies: number;
  unsubscribes: number;
};

export type HealthRow = {
  email: string;
  status: string;
  pause: string | null;
  bounceRate: string;
  lastSync: string | null;
  seedPlacement: string;
  warmup: string;
};

export type DashboardSnapshot = {
  from: string;
  to: string;
  today: string;
  approvalMode: string;
  totals: {
    sent: number;
    delivered: number;
    hardBounces: number;
    softBounces: number;
    replies: number;
    positiveReplies: number;
    unsubscribes: number;
    complaints: number | null;
  };
  tracking: { opens: number | null; clicks: number | null; note: string };
  queue: { ready: number | null; processing: number | null; reviewDrafts: number };
  caps: {
    fleetUsed: number;
    fleetCap: number;
    fleetHardMax: number;
    perInboxHardMax: number;
    ramp: string;
    inboxes: { email: string; used: number; cap: number; rampDay: number }[];
  };
  byInbox: InboxMetric[];
  byCampaign: CampaignMetric[];
  byDay: DayMetric[];
  funnel: FunnelRow[];
  health: HealthRow[];
  unsubSync: string;
  alerts: {
    disconnects: { email: string | null; detail: string; at: string }[];
    pauses: { scope: string; target: string; rule: string; detail: string | null; at: string }[];
    sync: { email: string; state: string; lastSync: string | null }[];
    failedJobs: { inbox: string; error: string | null; at: string }[];
  };
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function parseRange(input: { from?: string | null; to?: string | null }, now = new Date()): DashboardRange {
  const today = etDateISO(now);
  const from = input.from && DATE.test(input.from) ? input.from : today;
  const to = input.to && DATE.test(input.to) ? input.to : today;
  return from <= to ? { from, to } : { from: to, to: from };
}

function delivered(sent: number, hard: number, soft: number): number {
  return Math.max(0, sent - hard - soft);
}

async function readKv(db: Db, key: string): Promise<string | null> {
  const result = await db.query<{ v: string }>("SELECT v FROM app_kv WHERE k = $1", [key]);
  return result.rows[0]?.v ?? null;
}

async function count(db: Db, sql: string, params: unknown[]): Promise<number> {
  const result = await db.query<{ n: string }>(sql, params);
  return Number(result.rows[0]?.n ?? 0);
}

async function queueDepth(): Promise<{ ready: number | null; processing: number | null }> {
  const url = process.env.REDIS_URL;
  if (!url) return { ready: null, processing: null };
  const redis = new Redis(url, { connectTimeout: 1500, maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true });
  try {
    await redis.connect();
    const ready = await redis.llen(SEND_QUEUE_READY);
    const processing = await redis.llen(SEND_QUEUE_PROCESSING);
    return { ready, processing };
  } catch {
    return { ready: null, processing: null };
  } finally {
    redis.disconnect();
  }
}

function stamp(value: Date | null): string | null {
  if (!value) return null;
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export async function loadDashboard(
  db: Db,
  range: DashboardRange,
  opts: { queue?: { ready: number | null; processing: number | null } } = {},
): Promise<DashboardSnapshot> {
  const today = etDateISO(new Date());
  const settings = await loadSendSettings(db);
  const params = [range.from, range.to];
  const sent = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM sends WHERE state = 'sent' AND et_date BETWEEN $1::date AND $2::date`,
    params,
  );
  const hardBounces = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'hard_bounce' AND et_date BETWEEN $1::date AND $2::date`,
    params,
  );
  const softBounces = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'soft_bounce' AND et_date BETWEEN $1::date AND $2::date`,
    params,
  );
  const replies = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'reply' AND et_date BETWEEN $1::date AND $2::date`,
    params,
  );
  const positiveReplies = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM messages
     WHERE classification = 'interested'
       AND internal_date IS NOT NULL
       AND (internal_date AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date`,
    params,
  );
  const unsubscribes = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'unsubscribe' AND et_date BETWEEN $1::date AND $2::date`,
    params,
  );
  const complaintSource = await readKv(db, "complaint_source");
  const complaintEvents = await count(db, `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'complaint'`, []);
  const complaints =
    (complaintSource && !/TODO|BLOCKED|PLACEHOLDER/i.test(complaintSource)) || complaintEvents > 0
      ? await count(
          db,
          `SELECT COUNT(*)::text AS n FROM events WHERE kind = 'complaint' AND et_date BETWEEN $1::date AND $2::date`,
          params,
        )
      : null;
  const trackedOpens = await count(db, `SELECT COUNT(*)::text AS n FROM campaigns WHERE track_opens`, []);
  const trackedClicks = await count(db, `SELECT COUNT(*)::text AS n FROM campaigns WHERE track_clicks`, []);
  const opens =
    trackedOpens > 0
      ? await count(
          db,
          `SELECT COUNT(*)::text AS n FROM events e
           JOIN campaigns c ON c.id = e.campaign_id AND c.track_opens
           WHERE e.kind = 'open' AND e.et_date BETWEEN $1::date AND $2::date`,
          params,
        )
      : null;
  const clicks =
    trackedClicks > 0
      ? await count(
          db,
          `SELECT COUNT(*)::text AS n FROM events e
           JOIN campaigns c ON c.id = e.campaign_id AND c.track_clicks
           WHERE e.kind = 'click' AND e.et_date BETWEEN $1::date AND $2::date`,
          params,
        )
      : null;

  const byInbox = await db.query<{
    email: string;
    sent: string;
    hard: string;
    soft: string;
    replies: string;
    unsubs: string;
    positive: string;
  }>(
    `SELECT i.email,
            COALESCE(s.sent, 0)::text AS sent,
            COALESCE(e.hard, 0)::text AS hard,
            COALESCE(e.soft, 0)::text AS soft,
            COALESCE(e.replies, 0)::text AS replies,
            COALESCE(e.unsubs, 0)::text AS unsubs,
            COALESCE(p.positive, 0)::text AS positive
     FROM inboxes i
     LEFT JOIN (
       SELECT inbox_id, COUNT(*) FILTER (WHERE state = 'sent') AS sent
       FROM sends WHERE et_date BETWEEN $1::date AND $2::date GROUP BY inbox_id
     ) s ON s.inbox_id = i.id
     LEFT JOIN (
       SELECT inbox_id,
              COUNT(*) FILTER (WHERE kind = 'hard_bounce') AS hard,
              COUNT(*) FILTER (WHERE kind = 'soft_bounce') AS soft,
              COUNT(*) FILTER (WHERE kind = 'reply') AS replies,
              COUNT(*) FILTER (WHERE kind = 'unsubscribe') AS unsubs
       FROM events WHERE et_date BETWEEN $1::date AND $2::date GROUP BY inbox_id
     ) e ON e.inbox_id = i.id
     LEFT JOIN (
       SELECT inbox_id, COUNT(*) AS positive FROM messages
       WHERE classification = 'interested' AND internal_date IS NOT NULL
         AND (internal_date AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
       GROUP BY inbox_id
     ) p ON p.inbox_id = i.id
     ORDER BY i.email`,
    params,
  );

  const byCampaign = await db.query<{
    campaign: string;
    track_opens: boolean;
    track_clicks: boolean;
    sent: string;
    hard: string;
    soft: string;
    replies: string;
    unsubs: string;
    positive: string;
    opens: string;
    clicks: string;
  }>(
    `SELECT c.name AS campaign, c.track_opens, c.track_clicks,
            COALESCE(s.sent, 0)::text AS sent,
            COALESCE(e.hard, 0)::text AS hard,
            COALESCE(e.soft, 0)::text AS soft,
            COALESCE(e.replies, 0)::text AS replies,
            COALESCE(e.unsubs, 0)::text AS unsubs,
            COALESCE(e.opens, 0)::text AS opens,
            COALESCE(e.clicks, 0)::text AS clicks,
            COALESCE(p.positive, 0)::text AS positive
     FROM campaigns c
     LEFT JOIN (
       SELECT campaign_id, COUNT(*) FILTER (WHERE state = 'sent') AS sent
       FROM sends WHERE et_date BETWEEN $1::date AND $2::date GROUP BY campaign_id
     ) s ON s.campaign_id = c.id
     LEFT JOIN (
       SELECT campaign_id,
              COUNT(*) FILTER (WHERE kind = 'hard_bounce') AS hard,
              COUNT(*) FILTER (WHERE kind = 'soft_bounce') AS soft,
              COUNT(*) FILTER (WHERE kind = 'reply') AS replies,
              COUNT(*) FILTER (WHERE kind = 'unsubscribe') AS unsubs,
              COUNT(*) FILTER (WHERE kind = 'open') AS opens,
              COUNT(*) FILTER (WHERE kind = 'click') AS clicks
       FROM events WHERE et_date BETWEEN $1::date AND $2::date GROUP BY campaign_id
     ) e ON e.campaign_id = c.id
     LEFT JOIN (
       SELECT t.campaign_id, COUNT(*) AS positive
       FROM messages m JOIN threads t ON t.id = m.thread_row_id
       WHERE m.classification = 'interested' AND t.campaign_id IS NOT NULL AND m.internal_date IS NOT NULL
         AND (m.internal_date AT TIME ZONE 'America/New_York')::date BETWEEN $1::date AND $2::date
       GROUP BY t.campaign_id
     ) p ON p.campaign_id = c.id
     ORDER BY c.name`,
    params,
  );

  const byDay = await db.query<{ day: string; sent: string; hard: string; soft: string; replies: string; unsubs: string }>(
    `SELECT day::text, COALESCE(s.sent, 0)::text AS sent, COALESCE(e.hard, 0)::text AS hard,
            COALESCE(e.soft, 0)::text AS soft, COALESCE(e.replies, 0)::text AS replies, COALESCE(e.unsubs, 0)::text AS unsubs
     FROM (
       SELECT et_date AS day FROM sends WHERE et_date BETWEEN $1::date AND $2::date
       UNION
       SELECT et_date FROM events WHERE et_date BETWEEN $1::date AND $2::date
     ) days
     LEFT JOIN (
       SELECT et_date, COUNT(*) FILTER (WHERE state = 'sent') AS sent FROM sends GROUP BY et_date
     ) s ON s.et_date = days.day
     LEFT JOIN (
       SELECT et_date,
              COUNT(*) FILTER (WHERE kind = 'hard_bounce') AS hard,
              COUNT(*) FILTER (WHERE kind = 'soft_bounce') AS soft,
              COUNT(*) FILTER (WHERE kind = 'reply') AS replies,
              COUNT(*) FILTER (WHERE kind = 'unsubscribe') AS unsubs
       FROM events GROUP BY et_date
     ) e ON e.et_date = days.day
     ORDER BY day`,
    params,
  );

  const funnel = await db.query<{
    campaign: string;
    step: number;
    variant: string;
    sent: string;
    hard: string;
    soft: string;
    replies: string;
    positive: string;
    unsubs: string;
  }>(
    `SELECT c.name AS campaign, st.step_number AS step, sv.variant_key AS variant,
            (SELECT COUNT(*) FROM sends s
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND s.state = 'sent'
               AND s.et_date BETWEEN $1::date AND $2::date)::text AS sent,
            (SELECT COUNT(*) FROM events e JOIN sends s ON s.id = e.send_id
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND e.kind = 'hard_bounce'
               AND e.et_date BETWEEN $1::date AND $2::date)::text AS hard,
            (SELECT COUNT(*) FROM events e JOIN sends s ON s.id = e.send_id
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND e.kind = 'soft_bounce'
               AND e.et_date BETWEEN $1::date AND $2::date)::text AS soft,
            (SELECT COUNT(*) FROM events e JOIN sends s ON s.id = e.send_id
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND e.kind = 'reply'
               AND e.et_date BETWEEN $1::date AND $2::date)::text AS replies,
            (SELECT COUNT(*) FROM events e JOIN sends s ON s.id = e.send_id
             JOIN messages m ON m.inbox_id = e.inbox_id AND m.gmail_message_id = e.gmail_message_id
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND m.classification = 'interested'
               AND e.et_date BETWEEN $1::date AND $2::date)::text AS positive,
            (SELECT COUNT(*) FROM events e JOIN sends s ON s.id = e.send_id
             WHERE s.campaign_id = c.id AND s.step_number = st.step_number
               AND COALESCE(s.variant, '') = sv.variant_key AND e.kind = 'unsubscribe'
               AND e.et_date BETWEEN $1::date AND $2::date)::text AS unsubs
     FROM campaigns c
     JOIN sequence_steps st ON st.campaign_id = c.id
     JOIN step_variants sv ON sv.step_id = st.id
     ORDER BY c.name, st.step_number, sv.variant_key`,
    params,
  );

  const health = await db.query<{
    email: string;
    status: string;
    domain: string;
    id: string;
    last_sync_at: Date | null;
    warmup_status: string | null;
    warmup_source: string | null;
    pause_rule: string | null;
    pause_detail: string | null;
    sample: string;
    hard: string;
    seed_pct: string | null;
    spam_pct: string | null;
    seed_at: Date | null;
  }>(
    `SELECT i.email, i.status, i.domain, i.id::text, i.last_sync_at, i.warmup_status, i.warmup_source,
            p.rule AS pause_rule, p.detail AS pause_detail,
            COALESCE(b.sample, 0)::text AS sample,
            COALESCE(b.hard, 0)::text AS hard,
            seed.inbox_placement_pct::text AS seed_pct,
            seed.spam_pct::text AS spam_pct,
            seed.tested_at AS seed_at
     FROM inboxes i
     LEFT JOIN LATERAL (
       SELECT rule, detail FROM pauses
       WHERE resumed_at IS NULL
         AND (scope = 'fleet' OR (scope = 'inbox' AND target = i.email) OR (scope = 'domain' AND target = i.domain))
       ORDER BY paused_at DESC LIMIT 1
     ) p ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(*) AS sample,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM events e WHERE e.send_id = recent.id AND e.kind = 'hard_bounce'
              )) AS hard
       FROM (
         SELECT id FROM sends WHERE inbox_id = i.id AND state = 'sent'
         ORDER BY COALESCE(sent_at, reserved_at) DESC LIMIT 200
       ) recent
     ) b ON true
     LEFT JOIN LATERAL (
       SELECT inbox_placement_pct, spam_pct, tested_at
       FROM seed_tests WHERE inbox_id = i.id ORDER BY tested_at DESC LIMIT 1
     ) seed ON true
     ORDER BY i.email`,
  );

  const disconnects = await db.query<{ email: string | null; detail: string; created_at: Date }>(
    `SELECT i.email, a.detail, a.created_at
     FROM alerts a LEFT JOIN inboxes i ON i.id = a.inbox_id
     WHERE a.kind = 'inbox_disconnect' AND a.acknowledged_at IS NULL
     ORDER BY a.created_at DESC LIMIT 30`,
  );
  const pauses = await db.query<{ scope: string; target: string; rule: string; detail: string | null; paused_at: Date }>(
    `SELECT scope, target, rule, detail, paused_at FROM pauses WHERE resumed_at IS NULL ORDER BY paused_at DESC LIMIT 30`,
  );
  const failed = await db.query<{ email: string; error: string | null; at: Date }>(
    `SELECT i.email, s.error, COALESCE(s.sent_at, s.reserved_at) AS at
     FROM sends s JOIN inboxes i ON i.id = s.inbox_id
     WHERE s.state = 'failed'
     ORDER BY s.reserved_at DESC LIMIT 20`,
  );

  const reviewDrafts = await count(
    db,
    `SELECT COUNT(*)::text AS n FROM review_drafts WHERE state IN ('pending', 'edited', 'approved')`,
    [],
  );
  const queue = opts.queue ?? (await queueDepth());
  const fleetUsed = await countingTowardCap(db, today);
  const capInboxes: DashboardSnapshot["caps"]["inboxes"] = [];
  for (const row of health.rows) {
    const used = await countingTowardCap(db, today, row.id);
    const prior = await count(
      db,
      `SELECT COUNT(DISTINCT et_date)::text AS n FROM sends_counting_toward_cap
       WHERE inbox_id = $1 AND kind = 'prospect' AND et_date < $2::date`,
      [row.id, today],
    );
    const cap = await prospectInboxCap(db, { id: row.id, email: row.email, domain: row.domain }, today, settings.ramp, settings.maxPerInbox);
    capInboxes.push({ email: row.email, used, cap, rampDay: prior + 1 });
  }

  const unsubAt = await readKv(db, "unsub_sync_ok_at");
  const maxHours = settings.thresholds.unsubMaxHours;
  let unsubSync = "no unsub sync yet";
  if (unsubAt) {
    const age = Date.now() - new Date(unsubAt).getTime();
    const fresh = age <= maxHours * 60 * 60 * 1000;
    unsubSync = `${fresh ? "fresh" : "stale"} · ${unsubAt}`;
  }

  return {
    from: range.from,
    to: range.to,
    today,
    approvalMode: settings.approvalMode,
    totals: {
      sent,
      delivered: delivered(sent, hardBounces, softBounces),
      hardBounces,
      softBounces,
      replies,
      positiveReplies,
      unsubscribes,
      complaints,
    },
    tracking: {
      opens,
      clicks,
      note: "Unreliable. Apple Mail Privacy Protection inflates opens. Shown only when that campaign has tracking on.",
    },
    queue: { ready: queue.ready, processing: queue.processing, reviewDrafts },
    caps: {
      fleetUsed,
      fleetCap: fleetCeiling(settings.maxTotal),
      fleetHardMax: HARD_MAX_TOTAL,
      perInboxHardMax: HARD_MAX_PER_INBOX,
      ramp: settings.ramp.map((step) => `${step.days ?? "rest"}d→${step.perInbox}`).join(", "),
      inboxes: capInboxes,
    },
    byInbox: byInbox.rows.map((row) => ({
      email: row.email,
      sent: Number(row.sent),
      delivered: delivered(Number(row.sent), Number(row.hard), Number(row.soft)),
      hardBounces: Number(row.hard),
      softBounces: Number(row.soft),
      replies: Number(row.replies),
      positiveReplies: Number(row.positive),
      unsubscribes: Number(row.unsubs),
    })),
    byCampaign: byCampaign.rows.map((row) => ({
      campaign: row.campaign,
      sent: Number(row.sent),
      delivered: delivered(Number(row.sent), Number(row.hard), Number(row.soft)),
      hardBounces: Number(row.hard),
      softBounces: Number(row.soft),
      replies: Number(row.replies),
      positiveReplies: Number(row.positive),
      unsubscribes: Number(row.unsubs),
      opens: row.track_opens ? Number(row.opens) : null,
      clicks: row.track_clicks ? Number(row.clicks) : null,
      tracking: row.track_opens || row.track_clicks ? "on · unreliable (Apple MPP)" : "tracking off",
    })),
    byDay: byDay.rows.map((row) => ({
      day: row.day.slice(0, 10),
      sent: Number(row.sent),
      hardBounces: Number(row.hard),
      softBounces: Number(row.soft),
      replies: Number(row.replies),
      unsubscribes: Number(row.unsubs),
    })),
    funnel: funnel.rows.map((row) => ({
      campaign: row.campaign,
      step: row.step,
      variant: row.variant,
      sent: Number(row.sent),
      hardBounces: Number(row.hard),
      softBounces: Number(row.soft),
      replies: Number(row.replies),
      positiveReplies: Number(row.positive),
      unsubscribes: Number(row.unsubs),
    })),
    health: health.rows.map((row) => {
      const sample = Number(row.sample);
      const hard = Number(row.hard);
      return {
        email: row.email,
        status: row.status,
        pause: row.pause_rule ? `${row.pause_rule}${row.pause_detail ? ` · ${row.pause_detail}` : ""}` : null,
        bounceRate: sample === 0 ? "no data yet" : `${hard} / ${sample} hard bounces in the last ${sample} sent (window 200)`,
        lastSync: stamp(row.last_sync_at),
        seedPlacement: row.seed_pct
          ? `Seed-test estimate ${row.seed_pct}% inbox / ${row.spam_pct ?? "no data yet"}% spam at ${stamp(row.seed_at)}. Not real placement.`
          : "no data yet",
        warmup: row.warmup_status
          ? `${row.warmup_status} · ${row.warmup_source ?? "manual"}`
          : "TODO: warmup provider",
      };
    }),
    unsubSync,
    alerts: {
      disconnects: disconnects.rows.map((row) => ({ email: row.email, detail: row.detail, at: stamp(row.created_at) ?? "" })),
      pauses: pauses.rows.map((row) => ({
        scope: row.scope,
        target: row.target,
        rule: row.rule,
        detail: row.detail,
        at: stamp(row.paused_at) ?? "",
      })),
      sync: health.rows.map((row) => {
        if (!row.last_sync_at) return { email: row.email, state: "no sync yet", lastSync: null };
        const stale = Date.now() - row.last_sync_at.getTime() > maxHours * 60 * 60 * 1000;
        return { email: row.email, state: stale ? "stale" : "fresh", lastSync: stamp(row.last_sync_at) };
      }),
      failedJobs: failed.rows.map((row) => ({ inbox: row.email, error: row.error, at: stamp(row.at) ?? "" })),
    },
  };
}
