import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { snapshotCsv } from "@/lib/dashboard/csv";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { readSendingEnabled } from "@/lib/gates";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });
const queue = { ready: 3, processing: 1 };

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

it("parses a date range and swaps reversed bounds", () => {
  expect(parseRange({ from: "2026-10-01", to: "2026-10-19" })).toEqual({ from: "2026-10-01", to: "2026-10-19" });
  expect(parseRange({ from: "2026-10-19", to: "2026-10-01" })).toEqual({ from: "2026-10-01", to: "2026-10-19" });
  expect(parseRange({ from: "nope", to: null }, new Date("2026-10-19T15:00:00Z")).from).toBe("2026-10-19");
});

it("keeps the kill switch off", () => {
  expect(readSendingEnabled()).toBe(false);
});

it("counts ledger rows and refuses a complaint zero without a source", async () => {
  await withClient(async (client) => {
    const range = { from: "2026-10-19", to: "2026-10-19" };
    const before = await loadDashboard(client, range, { queue });
    const inbox = await client.query<{ id: string }>("SELECT id FROM inboxes WHERE email = 'divyam@usefigcel.com'");
    const quiet = await client.query<{ id: string }>("SELECT id FROM inboxes WHERE email = 'piyush@meetfigcel.com'");
    const inboxId = inbox.rows[0].id;
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const plainName = `Probe plain ${suffix}`;
    const trackedName = `Probe tracked ${suffix}`;
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (display_email, normalized_email, domain, company, timezone, verification_status)
       VALUES ($1, $1, split_part($1, '@', 2), 'Probe Co', 'America/New_York', 'valid')
       RETURNING id`,
      [`probe-${suffix}@example.test`],
    );
    const plain = await client.query<{ id: string }>(`INSERT INTO campaigns (name) VALUES ($1) RETURNING id`, [plainName]);
    const tracked = await client.query<{ id: string }>(
      `INSERT INTO campaigns (name, track_opens, track_clicks) VALUES ($1, true, true) RETURNING id`,
      [trackedName],
    );
    const step = await client.query<{ id: string }>(
      `INSERT INTO sequence_steps (campaign_id, step_number) VALUES ($1, 1) RETURNING id`,
      [plain.rows[0].id],
    );
    await client.query(`INSERT INTO step_variants (step_id, variant_key, body_template) VALUES ($1, 'A', 'Hello')`, [
      step.rows[0].id,
    ]);
    const send = await client.query<{ id: string }>(
      `INSERT INTO sends (contact_id, campaign_id, step_number, variant, inbox_id, kind, et_date, state, sent_at, template_ref)
       VALUES ($1, $2, 1, 'A', $3, 'prospect', '2026-10-19', 'sent', now(), 'probe')
       RETURNING id`,
      [contact.rows[0].id, plain.rows[0].id, inboxId],
    );
    const gmailId = `probe-${suffix}`;
    await client.query(
      `INSERT INTO events (inbox_id, contact_id, campaign_id, send_id, kind, et_date, gmail_message_id)
       VALUES ($1, $2, $3, $4, 'hard_bounce', '2026-10-19', NULL),
              ($1, $2, $3, $4, 'soft_bounce', '2026-10-19', NULL),
              ($1, $2, $3, $4, 'reply', '2026-10-19', $5),
              ($1, $2, $3, $4, 'unsubscribe', '2026-10-19', NULL)`,
      [inboxId, contact.rows[0].id, plain.rows[0].id, send.rows[0].id, gmailId],
    );
    const thread = await client.query<{ id: string }>(
      `INSERT INTO threads (inbox_id, gmail_thread_id, subject, contact_id, campaign_id)
       VALUES ($1, $2, 'Probe reply', $3, $4) RETURNING id`,
      [inboxId, `thread-${suffix}`, contact.rows[0].id, plain.rows[0].id],
    );
    await client.query(
      `INSERT INTO messages (inbox_id, thread_row_id, gmail_message_id, direction, from_email, internal_date, classification, body_text)
       VALUES ($1, $2, $3, 'in', $4, '2026-10-19T14:00:00Z', 'interested', 'Yes')`,
      [inboxId, thread.rows[0].id, gmailId, `probe-${suffix}@example.test`],
    );
    await client.query(
      `INSERT INTO events (inbox_id, campaign_id, kind, et_date, detail)
       VALUES ($1, $2, 'open', '2026-10-19', '{"probe":true}'::jsonb),
              ($1, $2, 'click', '2026-10-19', '{"probe":true}'::jsonb)`,
      [inboxId, tracked.rows[0].id],
    );

    const after = await loadDashboard(client, range, { queue });
    expect(after.totals.sent - before.totals.sent).toBe(1);
    expect(after.totals.hardBounces - before.totals.hardBounces).toBe(1);
    expect(after.totals.softBounces - before.totals.softBounces).toBe(1);
    expect(after.totals.delivered).toBe(Math.max(0, after.totals.sent - after.totals.hardBounces - after.totals.softBounces));
    expect(after.totals.replies - before.totals.replies).toBe(1);
    expect(after.totals.positiveReplies - before.totals.positiveReplies).toBe(1);
    expect(after.totals.unsubscribes - before.totals.unsubscribes).toBe(1);
    expect(after.totals.complaints).toBe(before.totals.complaints);
    expect(after.totals.complaints).toBeNull();

    const plainRow = after.byCampaign.find((row) => row.campaign === plainName);
    expect(plainRow?.sent).toBe(1);
    expect(plainRow?.delivered).toBe(0);
    expect(plainRow?.opens).toBeNull();
    expect(plainRow?.clicks).toBeNull();
    expect(plainRow?.tracking).toBe("tracking off");

    const trackedRow = after.byCampaign.find((row) => row.campaign === trackedName);
    expect(trackedRow?.opens).toBe(1);
    expect(trackedRow?.clicks).toBe(1);
    expect(trackedRow?.tracking).toContain("unreliable");
    expect(after.tracking.opens).toBe((before.tracking.opens ?? 0) + 1);
    expect(after.tracking.note).toMatch(/Apple/);

    const funnel = after.funnel.find((row) => row.campaign === plainName && row.variant === "A");
    expect(funnel).toMatchObject({ step: 1, sent: 1, hardBounces: 1, softBounces: 1, replies: 1, positiveReplies: 1, unsubscribes: 1 });

    const health = after.health.find((row) => row.email === "divyam@usefigcel.com");
    expect(health?.bounceRate).toMatch(/1 \/ 1 hard bounces/);
    expect(health?.warmup).toBe("TODO: warmup provider");
    expect(health?.lastSync).toBeNull();
    const untouched = after.health.find((row) => row.email === "piyush@meetfigcel.com");
    expect(untouched?.bounceRate).toBe("no data yet");
    expect(untouched?.seedPlacement).toBe("no data yet");
    expect(quiet.rows[0].id).toBeTruthy();

    expect(after.byDay.map((row) => row.day)).toContain("2026-10-19");
    const empty = await loadDashboard(client, { from: "1999-01-01", to: "1999-01-02" }, { queue: { ready: 0, processing: 0 } });
    expect(empty.byDay).toEqual([]);
    expect(empty.funnel.find((row) => row.campaign === plainName)?.sent).toBe(0);
    expect(empty.totals.sent).toBe(0);

    expect(after.caps.perInboxHardMax).toBe(27);
    expect(after.caps.fleetHardMax).toBe(405);
    expect(after.caps.fleetCap).toBeLessThanOrEqual(405);
    const used = after.caps.inboxes.find((row) => row.email === "divyam@usefigcel.com");
    expect(used?.used).toBe((before.caps.inboxes.find((row) => row.email === "divyam@usefigcel.com")?.used ?? 0) + 1);
    expect(used?.cap).toBeLessThanOrEqual(27);
    expect(after.queue).toEqual({ ready: 3, processing: 1, reviewDrafts: before.queue.reviewDrafts });
    expect(after.unsubSync).toBe("no unsub sync yet");
    expect(after.approvalMode).toBe("review");

    const csv = snapshotCsv("summary", after);
    expect(csv).toContain("complaints");
    expect(csv).toContain("no source");
    expect(snapshotCsv("by-campaign", after)).toContain("tracking off");
    expect(snapshotCsv("by-campaign", after)).toContain("unreliable");
    expect(snapshotCsv("health", after)).toContain("TODO: warmup provider");
    expect(snapshotCsv("health", after)).toContain("no data yet");
    expect(snapshotCsv("by-day", empty).trim().split("\r\n")).toHaveLength(1);
  });
});
