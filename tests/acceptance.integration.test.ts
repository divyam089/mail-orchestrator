import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { scopesForRole } from "@/lib/api/actions";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { readSendingEnabled } from "@/lib/gates";
import type { MailAdapter } from "@/lib/mail/adapter";
import { executeSend } from "@/lib/send/execute";
import { stopFromInbound } from "@/lib/send/inbound";
import { planDay } from "@/lib/send/plan";
import { MemorySendQueue } from "@/lib/send/queue";
import { touchKv } from "@/lib/send/settings";
import { drainQueue } from "@/lib/send/worker";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });
const ET_DAY = "2026-11-02";
const PLAN_AT = new Date("2026-11-02T14:00:00.000Z");
const SEND_AT = new Date("2026-11-02T20:30:00.000Z");

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

function recorder() {
  const calls: { to?: string; from: string }[] = [];
  const adapter: MailAdapter = {
    provider: "mock",
    async send(message) {
      calls.push({ to: message.to, from: message.from });
      return { id: `g-${calls.length}`, threadId: message.threadId ?? `t-${calls.length}` };
    },
  };
  return { adapter, calls };
}

async function openDay(client: PoolClient) {
  await client.query(
    `UPDATE app_settings SET
       legal_name = 'Figcel Inc.',
       postal_address = '1 Market Street, San Francisco, CA 94105',
       unsubscribe_https_base = 'https://unsub.test',
       approval_mode = 'auto',
       max_per_inbox = 27,
       max_total = 405,
       new_per_inbox_per_day = 9,
       ramp = '[[null, 27]]'::jsonb
     WHERE id = 1`,
  );
  await touchKv(client, "unsub_sync_ok_at", SEND_AT);
  await touchKv(client, "poll_ok_at", SEND_AT);
  await client.query("UPDATE pauses SET resumed_at = now() WHERE resumed_at IS NULL");
  await client.query("UPDATE inboxes SET status = 'active'");
  await client.query("DELETE FROM schedule WHERE et_date = $1", [ET_DAY]);
}

async function addContact(client: PoolClient, email: string, first: string) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO contacts (display_email, normalized_email, domain, first_name, company, timezone, verification_status)
     VALUES ($1, $1, split_part($1, '@', 2), $2, 'Analytical', 'America/New_York', 'valid')
     RETURNING id`,
    [email, first],
  );
  return result.rows[0].id;
}

async function addCampaign(client: PoolClient) {
  const campaign = await client.query<{ id: string }>(
    `INSERT INTO campaigns (name, status) VALUES ('Load day', 'active') RETURNING id`,
  );
  const campaignId = campaign.rows[0].id;
  const step1 = await client.query<{ id: string }>(
    `INSERT INTO sequence_steps (campaign_id, step_number, delay_business_days) VALUES ($1, 1, 0) RETURNING id`,
    [campaignId],
  );
  const step2 = await client.query<{ id: string }>(
    `INSERT INTO sequence_steps (campaign_id, step_number, delay_business_days) VALUES ($1, 2, 0) RETURNING id`,
    [campaignId],
  );
  await client.query(
    `INSERT INTO step_variants (step_id, variant_key, subject_template, body_template, weight)
     VALUES ($1, 'A', 'Hello {{first_name}}', 'We help {{company}}.', 1)`,
    [step1.rows[0].id],
  );
  await client.query(
    `INSERT INTO step_variants (step_id, variant_key, subject_template, body_template, weight)
     VALUES ($1, 'A', NULL, 'Following up with {{first_name}}.', 1)`,
    [step2.rows[0].id],
  );
  return campaignId;
}

it("keeps viewer, operator, and admin on separate scopes", () => {
  expect(readSendingEnabled()).toBe(false);
  const viewer = scopesForRole("viewer");
  const operator = scopesForRole("operator");
  const admin = scopesForRole("admin");
  expect(viewer).not.toContain("campaigns.write");
  expect(viewer).not.toContain("keys.manage");
  expect(operator).toContain("campaigns.write");
  expect(operator).toContain("review.write");
  expect(operator).not.toContain("keys.manage");
  expect(operator).not.toContain("inboxes.write");
  expect(operator).not.toContain("approval.write");
  expect(admin).toContain("keys.manage");
  expect(admin).toContain("inboxes.write");
  expect(admin).toContain("approval.write");
});

it("stops the rest of a sequence when a reply arrives", async () => {
  await withClient(async (client) => {
    await openDay(client);
    const campaignId = await addCampaign(client);
    const contactId = await addContact(client, "ada@reply.test", "Ada");
    const enrollment = await client.query<{ id: string }>(
      `INSERT INTO enrollments (campaign_id, contact_id, status, next_step) VALUES ($1, $2, 'active', 1) RETURNING id`,
      [campaignId, contactId],
    );
    const planned = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue: new MemorySendQueue() });
    expect(planned.planned).toBe(1);
    const inbox = await client.query<{ id: string }>("SELECT id FROM inboxes WHERE email = 'divyam@usefigcel.com'");
    const stopped = await stopFromInbound(client, {
      inboxId: inbox.rows[0].id,
      gmailMessageId: "reply-1",
      fromEmail: "Ada <ada@reply.test>",
      subject: "Re: Hello",
      bodyText: "Tuesday afternoon works.",
      now: SEND_AT,
    });
    expect(stopped.stopped).toBe(1);
    const row = await client.query<{ status: string; stop_reason: string }>(
      "SELECT status, stop_reason FROM enrollments WHERE id = $1",
      [enrollment.rows[0].id],
    );
    expect(row.rows[0]).toEqual({ status: "stopped", stop_reason: "reply" });
    const schedule = await client.query<{ state: string }>("SELECT state FROM schedule WHERE contact_id = $1", [contactId]);
    expect(schedule.rows[0].state).toBe("skipped");
    const { adapter, calls } = recorder();
    const scheduleId = await client.query<{ id: string }>("SELECT id FROM schedule WHERE contact_id = $1", [contactId]);
    const result = await executeSend(client, { scheduleId: scheduleId.rows[0].id }, {
      adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
    });
    expect(result.outcome).toBe("already_locked");
    expect(calls).toHaveLength(0);
  });
});

it("lets two workers race one schedule and call Gmail once", async () => {
  const setup = await pool.connect();
  const saved = await setup.query<{
    legal_name: string;
    postal_address: string;
    unsubscribe_https_base: string;
    approval_mode: string;
    max_per_inbox: number;
    max_total: number;
    new_per_inbox_per_day: number;
    ramp: unknown;
  }>(
    `SELECT legal_name, postal_address, unsubscribe_https_base, approval_mode, max_per_inbox, max_total, new_per_inbox_per_day, ramp
     FROM app_settings WHERE id = 1`,
  );
  const inboxes = await setup.query<{ id: string; status: string }>("SELECT id, status FROM inboxes");
  const kv = await setup.query<{ k: string; v: string }>(
    "SELECT k, v FROM app_kv WHERE k IN ('unsub_sync_ok_at', 'poll_ok_at')",
  );
  let campaignId = "";
  let contactId = "";
  try {
    await setup.query("BEGIN");
    await openDay(setup);
    campaignId = await addCampaign(setup);
    contactId = await addContact(setup, "ada@race.test", "Ada");
    await setup.query(
      `INSERT INTO enrollments (campaign_id, contact_id, status, next_step) VALUES ($1, $2, 'active', 1)`,
      [campaignId, contactId],
    );
    const queue = new MemorySendQueue();
    const planned = await planDay(setup, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
    expect(planned.planned).toBe(1);
    await setup.query("UPDATE schedule SET due_at = $1 WHERE et_date = $2", [PLAN_AT, ET_DAY]);
    await setup.query("COMMIT");
    const schedule = await pool.query<{ id: string }>("SELECT id FROM schedule WHERE contact_id = $1", [contactId]);
    const { adapter, calls } = recorder();
    const opts = { adapter, now: SEND_AT, sendingEnabled: true as const, sendMode: "live" as const };
    const raced = await Promise.all([
      executeSend(pool, { scheduleId: schedule.rows[0].id }, opts),
      executeSend(pool, { scheduleId: schedule.rows[0].id }, opts),
    ]);
    expect(calls).toHaveLength(1);
    expect(raced.filter((item) => item.outcome === "sent")).toHaveLength(1);
    expect(raced.filter((item) => item.outcome === "already_locked")).toHaveLength(1);
    const sends = await pool.query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM sends WHERE contact_id = $1 AND state = 'sent'",
      [contactId],
    );
    expect(sends.rows[0].n).toBe("1");
  } finally {
    await setup.query("ROLLBACK").catch(() => undefined);
    await pool.query("DELETE FROM events WHERE contact_id = $1", [contactId || "00000000-0000-0000-0000-000000000000"]);
    await pool.query("DELETE FROM sends WHERE campaign_id = $1", [campaignId || "00000000-0000-0000-0000-000000000000"]);
    await pool.query("DELETE FROM schedule WHERE campaign_id = $1", [campaignId || "00000000-0000-0000-0000-000000000000"]);
    await pool.query(
      "DELETE FROM review_drafts WHERE enrollment_id IN (SELECT id FROM enrollments WHERE campaign_id = $1)",
      [campaignId || "00000000-0000-0000-0000-000000000000"],
    );
    await pool.query("DELETE FROM enrollments WHERE campaign_id = $1", [campaignId || "00000000-0000-0000-0000-000000000000"]);
    await pool.query("DELETE FROM campaigns WHERE id = $1", [campaignId || "00000000-0000-0000-0000-000000000000"]);
    await pool.query("DELETE FROM contacts WHERE id = $1", [contactId || "00000000-0000-0000-0000-000000000000"]);
    const row = saved.rows[0];
    await pool.query(
      `UPDATE app_settings SET
         legal_name = $1, postal_address = $2, unsubscribe_https_base = $3, approval_mode = $4,
         max_per_inbox = $5, max_total = $6, new_per_inbox_per_day = $7, ramp = $8::jsonb
       WHERE id = 1`,
      [
        row.legal_name,
        row.postal_address,
        row.unsubscribe_https_base,
        row.approval_mode,
        row.max_per_inbox,
        row.max_total,
        row.new_per_inbox_per_day,
        JSON.stringify(row.ramp),
      ],
    );
    for (const inbox of inboxes.rows) {
      await pool.query("UPDATE inboxes SET status = $2 WHERE id = $1", [inbox.id, inbox.status]);
    }
    await pool.query("DELETE FROM app_kv WHERE k IN ('unsub_sync_ok_at', 'poll_ok_at')");
    for (const row of kv.rows) {
      await pool.query("INSERT INTO app_kv (k, v) VALUES ($1, $2)", [row.k, row.v]);
    }
    setup.release();
  }
});

it(
  "simulates a 405-send day across 15 inboxes with a fake Gmail adapter",
  async () => {
    await withClient(async (client) => {
      await openDay(client);
      const inboxes = await client.query<{ id: string; email: string }>("SELECT id, email FROM inboxes ORDER BY email");
      expect(inboxes.rows).toHaveLength(15);
      const campaignId = await addCampaign(client);
      for (const [index, inbox] of inboxes.rows.entries()) {
        for (let n = 0; n < 18; n += 1) {
          const contactId = await addContact(client, `fu.${index}.${n}@load.test`, "Follow");
          await client.query(
            `INSERT INTO enrollments (campaign_id, contact_id, status, inbox_id, next_step, step1_et_date, first_subject)
             VALUES ($1, $2, 'active', $3, 2, '2026-10-01', 'Hello Follow')`,
            [campaignId, contactId, inbox.id],
          );
        }
        for (let n = 0; n < 9; n += 1) {
          const contactId = await addContact(client, `new.${index}.${n}@load.test`, "New");
          await client.query(
            `INSERT INTO enrollments (campaign_id, contact_id, status, next_step) VALUES ($1, $2, 'active', 1)`,
            [campaignId, contactId],
          );
        }
      }
      await client.query(
        `INSERT INTO enrollments (campaign_id, contact_id, status, next_step) VALUES ($1, $2, 'active', 1)`,
        [campaignId, await addContact(client, "extra@load.test", "Extra")],
      );

      const queue = new MemorySendQueue();
      const planned = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
      expect(planned.planned).toBe(405);
      await client.query("UPDATE schedule SET due_at = $1 WHERE et_date = $2", [PLAN_AT, ET_DAY]);

      const { adapter, calls } = recorder();
      const results = await drainQueue(client, queue, {
        adapter,
        now: SEND_AT,
        sendingEnabled: true,
        sendMode: "live",
        limit: 500,
        rng: () => 0,
      });
      expect(results.filter((item) => item.outcome === "sent")).toHaveLength(405);
      expect(calls).toHaveLength(405);
      const perInbox = await client.query<{ email: string; n: number }>(
        `SELECT i.email, COUNT(*)::int AS n
         FROM sends s JOIN inboxes i ON i.id = s.inbox_id
         WHERE s.state = 'sent' AND s.campaign_id = $1
         GROUP BY i.email ORDER BY i.email`,
        [campaignId],
      );
      expect(perInbox.rows).toHaveLength(15);
      for (const row of perInbox.rows) expect(row.n).toBe(27);

      const again = await drainQueue(client, queue, {
        adapter,
        now: SEND_AT,
        sendingEnabled: true,
        sendMode: "live",
        limit: 50,
      });
      expect(again).toHaveLength(0);
      expect(calls).toHaveLength(405);

      const inbox = inboxes.rows[0];
      const leftOut = await client.query<{ id: string; contact_id: string; next_step: number }>(
        `SELECT e.id, e.contact_id, e.next_step
         FROM enrollments e
         WHERE e.campaign_id = $1
           AND NOT EXISTS (SELECT 1 FROM schedule s WHERE s.enrollment_id = e.id)
         LIMIT 1`,
        [campaignId],
      );
      expect(leftOut.rows).toHaveLength(1);
      const extraSchedule = await client.query<{ id: string }>(
        `INSERT INTO schedule (et_date, inbox_id, contact_id, campaign_id, enrollment_id, step_number, due_at, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'planned')
         RETURNING id`,
        [ET_DAY, inbox.id, leftOut.rows[0].contact_id, campaignId, leftOut.rows[0].id, leftOut.rows[0].next_step, PLAN_AT],
      );
      const overflow = await executeSend(client, { scheduleId: extraSchedule.rows[0].id }, {
        adapter,
        now: SEND_AT,
        sendingEnabled: true,
        sendMode: "live",
      });
      expect(overflow.outcome).toBe("deferred");
      expect(overflow.reason ?? "").toMatch(/cap/);
      expect(calls).toHaveLength(405);
      expect(readSendingEnabled()).toBe(false);
    });
  },
  180_000,
);
