import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { readSendingEnabled } from "@/lib/gates";
import type { MailAdapter } from "@/lib/mail/adapter";
import { createRedis } from "@/lib/redis";
import { prospectInboxCap } from "@/lib/send/capacity";
import { executeSeed, executeSend } from "@/lib/send/execute";
import { stopFromInbound } from "@/lib/send/inbound";
import { planDay } from "@/lib/send/plan";
import { MemorySendQueue, RedisSendQueue } from "@/lib/send/queue";
import { decideDraft, setApprovalMode } from "@/lib/send/review";
import { loadSendSettings, touchKv } from "@/lib/send/settings";
import { complaintCheck, hardBounceCheck, seedResult, updateStopThresholds, blacklistHit } from "@/lib/send/stops";
import { drainQueue } from "@/lib/send/worker";
import { etDateISO } from "@/lib/window";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });
const PLAN_AT = new Date("2026-10-22T13:00:00.000Z");
const SEND_AT = new Date("2026-10-22T20:50:00.000Z");
const ET_DAY = "2026-10-22";

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

function recorder(failAt?: number) {
  const calls: { to?: string; raw: string; threadId?: string; from: string }[] = [];
  const adapter: MailAdapter = {
    provider: "mock",
    async send(message) {
      calls.push({ to: message.to, raw: message.raw, threadId: message.threadId, from: message.from });
      if (failAt != null && calls.length === failAt) throw new Error("550 5.7.26 message rejected");
      return { id: `g-${calls.length}`, threadId: message.threadId ?? `t-${calls.length}` };
    },
  };
  return { adapter, calls };
}

async function openGates(client: PoolClient, mode: "review" | "auto" = "review") {
  await client.query(
    `UPDATE app_settings SET
       legal_name = 'Figcel Inc.',
       postal_address = '1 Market Street, San Francisco, CA 94105',
       unsubscribe_https_base = 'https://unsub.test',
       approval_mode = $1
     WHERE id = 1`,
    [mode],
  );
  await touchKv(client, "unsub_sync_ok_at", SEND_AT);
  await touchKv(client, "poll_ok_at", SEND_AT);
  await client.query(
    `UPDATE inboxes SET status = 'active' WHERE email IN ('divyam@usefigcel.com', 'piyush@usefigcel.com')`,
  );
}

async function addContact(
  client: PoolClient,
  email: string,
  extras: { status?: string; timezone?: string; first?: string } = {},
) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO contacts (display_email, normalized_email, domain, first_name, company, timezone, verification_status)
     VALUES ($1, $1, split_part($1, '@', 2), $2, 'Analytical', $3, $4)
     RETURNING id`,
    [email, extras.first ?? "Ada", extras.timezone ?? "America/New_York", extras.status ?? "valid"],
  );
  return result.rows[0].id;
}

async function addCampaign(client: PoolClient, name: string, override: "review" | "auto" | null = null) {
  const campaign = await client.query<{ id: string }>(
    `INSERT INTO campaigns (name, status, approval_override) VALUES ($1, 'active', $2) RETURNING id`,
    [name, override],
  );
  const campaignId = campaign.rows[0].id;
  const step1 = await client.query<{ id: string }>(
    `INSERT INTO sequence_steps (campaign_id, step_number, delay_business_days) VALUES ($1, 1, 0) RETURNING id`,
    [campaignId],
  );
  const step2 = await client.query<{ id: string }>(
    `INSERT INTO sequence_steps (campaign_id, step_number, delay_business_days) VALUES ($1, 2, 3) RETURNING id`,
    [campaignId],
  );
  await client.query(
    `INSERT INTO step_variants (step_id, variant_key, subject_template, body_template, weight)
     VALUES ($1, 'A', '{Hi|Hello} {{first_name}}', 'We help {{company}}.', 1),
            ($1, 'B', 'Quick note {{first_name}}', 'Another {{company}} note.', 1)`,
    [step1.rows[0].id],
  );
  await client.query(
    `INSERT INTO step_variants (step_id, variant_key, subject_template, body_template, weight)
     VALUES ($1, 'A', NULL, 'Following up with {{first_name}}.', 1)`,
    [step2.rows[0].id],
  );
  return campaignId;
}

async function enroll(client: PoolClient, campaignId: string, contactId: string) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO enrollments (campaign_id, contact_id, status) VALUES ($1, $2, 'active') RETURNING id`,
    [campaignId, contactId],
  );
  return result.rows[0].id;
}

it("keeps the process kill switch off", () => {
  expect(readSendingEnabled()).toBe(false);
  expect(process.env.SENDING_ENABLED ?? "false").not.toBe("true");
});

it("leaves mail in Review when approval is off, even if sending is enabled for the call", async () => {
  await withClient(async (client) => {
    await openGates(client, "review");
    const campaignId = await addCampaign(client, "Review pilot");
    await enroll(client, campaignId, await addContact(client, "ada@acme.test"));
    const { adapter, calls } = recorder();
    const summary = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue: new MemorySendQueue() });
    expect(summary.drafted).toBe(1);
    expect(summary.planned).toBe(0);
    const drafts = await client.query("SELECT subject, body, state FROM review_drafts");
    expect(drafts.rows[0].state).toBe("pending");
    expect(drafts.rows[0].subject).toBe("Hi Ada");
    expect(drafts.rows[0].body).toContain("Unsubscribe:");
    expect(drafts.rows[0].body).not.toContain("/o/");
    const schedule = await client.query<{ id: string }>("SELECT id FROM schedule");
    const result = await executeSend(client, { scheduleId: schedule.rows[0].id }, {
      adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
    });
    expect(result.outcome).toBe("deferred");
    expect(calls).toHaveLength(0);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM sends")).rows[0].n).toBe(0);
  });
});

it("does not send an unverified contact or a suppressed one, and rechecks suppression at send time", async () => {
  await withClient(async (client) => {
    await openGates(client, "auto");
    const campaignId = await addCampaign(client, "Gate pilot");
    const unknownId = await addContact(client, "unknown@acme.test", { status: "unknown" });
    await enroll(client, campaignId, unknownId);
    const held = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0 });
    expect(held.planned).toBe(0);

    const liveId = await addContact(client, "bea@acme.test", { first: "Bea" });
    await enroll(client, campaignId, liveId);
    const queue = new MemorySendQueue();
    const planned = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
    expect(planned.planned).toBe(1);
    await client.query(
      `INSERT INTO suppression (kind, value, reason) VALUES ('email', 'bea@acme.test', 'manual')`,
    );
    const { adapter, calls } = recorder();
    const results = await drainQueue(client, queue, { adapter, now: SEND_AT, sendingEnabled: true, sendMode: "live" });
    expect(results[0].outcome).toBe("skipped");
    expect(calls).toHaveLength(0);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM sends")).rows[0].n).toBe(0);
    const stopped = await client.query<{ status: string }>("SELECT status FROM enrollments WHERE contact_id = $1", [liveId]);
    expect(stopped.rows[0].status).toBe("stopped");
  });
});

it("does not send a step twice when the worker dies after the adapter returns", async () => {
  await withClient(async (client) => {
    await openGates(client, "auto");
    const campaignId = await addCampaign(client, "Crash pilot");
    await enroll(client, campaignId, await addContact(client, "ada@acme.test"));
    await enroll(client, campaignId, await addContact(client, "bea@acme.test", { first: "Bea" }));
    const redis = createRedis();
    const queue = new RedisSendQueue(redis, "outreach:send-queue:step4", "outreach:send-queue:step4:processing");
    await queue.clear();
    try {
      const planned = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
      expect(planned.planned).toBe(2);
      const { adapter, calls } = recorder();
      let finished = 0;
      await expect(
        drainQueue(client, queue, {
          adapter,
          now: SEND_AT,
          sendingEnabled: true,
          sendMode: "live",
          rng: () => 0,
          hooks: {
            afterAdapter() {
              finished += 1;
              if (finished === 2) throw new Error("killed");
            },
          },
        }),
      ).rejects.toThrow(/killed/);
      expect(calls).toHaveLength(2);
      await queue.requeueInflight();
      const again = await drainQueue(client, queue, {
        adapter,
        now: SEND_AT,
        sendingEnabled: true,
        sendMode: "live",
      });
      expect(again.map((item) => item.outcome)).toEqual(["already_locked"]);
      expect(calls).toHaveLength(2);
      const rows = await client.query<{ state: string; n: string }>(
        "SELECT state, COUNT(*)::text AS n FROM sends GROUP BY state ORDER BY state",
      );
      expect(rows.rows).toEqual([
        { state: "sending", n: "1" },
        { state: "sent", n: "1" },
      ]);
    } finally {
      await queue.clear();
      redis.disconnect();
    }
  });
});

it("enforces the inbox cap, the hard database caps, and a ramp hold after a stop", async () => {
  await withClient(async (client) => {
    await openGates(client, "auto");
    await client.query(
      `UPDATE app_settings
       SET max_per_inbox = 1, new_per_inbox_per_day = 1, ramp = '[[null, 1]]'::jsonb
       WHERE id = 1`,
    );
    await client.query("UPDATE inboxes SET status = 'paused' WHERE email = 'piyush@usefigcel.com'");
    const campaignId = await addCampaign(client, "Cap pilot");
    for (const email of ["ada@acme.test", "bea@acme.test", "cy@acme.test"]) {
      await enroll(client, campaignId, await addContact(client, email, { first: email.slice(0, 1).toUpperCase() }));
    }
    const summary = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue: new MemorySendQueue() });
    expect(summary.planned).toBe(1);
    await client.query("SAVEPOINT cap_guard");
    await expect(client.query("UPDATE app_settings SET max_per_inbox = 28 WHERE id = 1")).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK TO SAVEPOINT cap_guard");
    await expect(client.query("UPDATE app_settings SET max_total = 406 WHERE id = 1")).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK TO SAVEPOINT cap_guard");

    const inbox = await client.query<{ id: string; email: string; domain: string }>(
      "SELECT id, email, domain FROM inboxes WHERE email = 'divyam@usefigcel.com'",
    );
    for (const [index, day] of ["2026-10-19", "2026-10-20", "2026-10-21"].entries()) {
      const contactId = await addContact(client, `old${index}@acme.test`);
      await client.query(
        `INSERT INTO sends (contact_id, campaign_id, step_number, inbox_id, kind, et_date, state, sent_at)
         VALUES ($1, $2, 1, $3, 'prospect', $4, 'sent', now())`,
        [contactId, campaignId, inbox.rows[0].id, day],
      );
    }
    expect(await prospectInboxCap(client, inbox.rows[0], "2026-10-22", [
      { days: 3, perInbox: 9 },
      { days: 4, perInbox: 18 },
      { days: null, perInbox: 27 },
    ], 27)).toBe(18);
    await client.query(
      `INSERT INTO events (inbox_id, kind, et_date, detail) VALUES ($1, 'hard_bounce', '2026-10-21', '{}'::jsonb)`,
      [inbox.rows[0].id],
    );
    expect(await prospectInboxCap(client, inbox.rows[0], "2026-10-22", [
      { days: 3, perInbox: 9 },
      { days: 4, perInbox: 18 },
      { days: null, perInbox: 27 },
    ], 27)).toBe(9);
  });
});

it("threads step 2 as a reply and refuses a weekend clock at send time", async () => {
  await withClient(async (client) => {
    await openGates(client, "auto");
    const campaignId = await addCampaign(client, "Thread pilot");
    const contactId = await addContact(client, "ada@acme.test");
    await enroll(client, campaignId, contactId);
    const queue = new MemorySendQueue();
    await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
    const { adapter, calls } = recorder();
    const first = await drainQueue(client, queue, { adapter, now: SEND_AT, sendingEnabled: true, sendMode: "live", rng: () => 0 });
    expect(first[0].outcome).toBe("sent");
    const mime1 = Buffer.from(calls[0].raw, "base64url").toString("utf8");
    expect(mime1).toContain("List-Unsubscribe: <https://unsub.test/u/");
    expect(mime1).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(mime1).not.toContain("In-Reply-To:");
    const enrollment = await client.query<{ last_rfc_message_id: string; thread_ready: string; id: string }>(
      "SELECT id, last_rfc_message_id, thread_id AS thread_ready FROM enrollments WHERE contact_id = $1",
      [contactId],
    );
    await client.query(
      `INSERT INTO schedule (et_date, inbox_id, contact_id, campaign_id, enrollment_id, step_number, due_at, state)
       SELECT $1, inbox_id, contact_id, campaign_id, id, 2, $2, 'planned' FROM enrollments WHERE id = $3`,
      [ET_DAY, SEND_AT, enrollment.rows[0].id],
    );
    const step2 = await client.query<{ id: string }>(
      "SELECT id FROM schedule WHERE step_number = 2",
    );
    const weekend = await executeSend(client, { scheduleId: step2.rows[0].id }, {
      adapter,
      now: new Date("2026-10-24T16:00:00.000Z"),
      sendingEnabled: true,
      sendMode: "live",
    });
    expect(weekend.outcome).toBe("deferred");
    expect(weekend.reason).toMatch(/weekend/);
    expect(calls).toHaveLength(1);

    const second = await executeSend(client, { scheduleId: step2.rows[0].id }, {
      adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
      rng: () => 0,
    });
    expect(second.outcome).toBe("sent");
    expect(calls[1].threadId).toBe("t-1");
    const mime2 = Buffer.from(calls[1].raw, "base64url").toString("utf8");
    expect(mime2).toContain("Subject: Re: Hi Ada");
    expect(mime2).toContain(`In-Reply-To: ${enrollment.rows[0].last_rfc_message_id}`);
    expect(mime2).toContain(`References: ${enrollment.rows[0].last_rfc_message_id}`);
  });
});

it("applies dry-run, seed-only, provider pause, and stop rules", async () => {
  await withClient(async (client) => {
    await openGates(client, "auto");
    const campaignId = await addCampaign(client, "Mode pilot");
    const contactId = await addContact(client, "ada@acme.test");
    await enroll(client, campaignId, contactId);
    const queue = new MemorySendQueue();
    await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0, queue });
    const dry = recorder();
    const dryResult = await drainQueue(client, queue, {
      adapter: dry.adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "dry-run",
    });
    expect(dryResult[0].outcome).toBe("deferred");
    expect(dry.calls).toHaveLength(0);

    const seedOnly = recorder();
    const blocked = await drainQueue(client, queue, {
      adapter: seedOnly.adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "seed-only",
    });
    expect(blocked[0].outcome).toBe("deferred");
    expect(seedOnly.calls).toHaveLength(0);
    await client.query("INSERT INTO seed_addresses (email) VALUES ('seed@acme.test')");
    const seeded = recorder();
    const seedSend = await executeSeed(client, {
      adapter: seeded.adapter,
      inboxEmail: "divyam@usefigcel.com",
      seedEmail: "seed@acme.test",
      subject: "Seed",
      body: "Placement check",
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "seed-only",
    });
    expect(seedSend.outcome).toBe("sent");
    expect(seeded.calls).toHaveLength(1);

    const live = recorder(1);
    const provider = await drainQueue(client, queue, {
      adapter: live.adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
      rng: () => 0,
    });
    expect(provider[0].outcome).toBe("provider_stop");
    const paused = await client.query("SELECT rule FROM pauses WHERE resumed_at IS NULL");
    expect(paused.rows[0].rule).toBe("R6_provider_error");
    const retry = await drainQueue(client, new MemorySendQueue(), {
      adapter: live.adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
    });
    expect(retry).toEqual([]);
    const schedule = await client.query<{ id: string }>("SELECT id FROM schedule WHERE state = 'error'");
    const second = await executeSend(client, { scheduleId: schedule.rows[0].id }, {
      adapter: live.adapter,
      now: SEND_AT,
      sendingEnabled: true,
      sendMode: "live",
    });
    expect(second.outcome).toBe("already_locked");
    expect(live.calls).toHaveLength(1);

    const inbox = await client.query<{ id: string; email: string }>(
      "SELECT id, email FROM inboxes WHERE email = 'piyush@usefigcel.com'",
    );
    const other = await addContact(client, "bounce@acme.test");
    await client.query(
      `INSERT INTO sends (contact_id, campaign_id, step_number, inbox_id, kind, et_date, state)
       VALUES ($1, $2, 1, $3, 'prospect', $4, 'sent')`,
      [other, campaignId, inbox.rows[0].id, ET_DAY],
    );
    await client.query(
      `INSERT INTO events (inbox_id, contact_id, kind, et_date) VALUES ($1, $2, 'hard_bounce', $3)`,
      [inbox.rows[0].id, other, ET_DAY],
    );
    expect(await hardBounceCheck(client)).toContain(inbox.rows[0].email);
    expect(await complaintCheck(client, { domain: "acme.test", complaints: 1, delivered: 1000, source: "test" })).toBe("pause");
    expect(await seedResult(client, { inboxId: inbox.rows[0].id, inboxEmail: inbox.rows[0].email, inboxPct: 79, report: "seed", at: SEND_AT })).toBe(true);
    await blacklistHit(client, { domain: "acme.test", listName: "spamhaus", at: SEND_AT });
    const measurement = await client.query<{ measurement: string }>("SELECT measurement FROM seed_tests");
    expect(measurement.rows[0].measurement).toBe("seed_test_only");
  });
});

it("stops a sequence when sync sees a reply and audits approval and threshold changes", async () => {
  await withClient(async (client) => {
    await openGates(client, "review");
    const campaignId = await addCampaign(client, "Stop pilot", "auto");
    const contactId = await addContact(client, "ada@acme.test");
    const enrollmentId = await enroll(client, campaignId, contactId);
    const summary = await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0 });
    expect(summary.drafted).toBe(1);
    expect(summary.planned).toBe(0);

    await client.query("UPDATE app_settings SET approval_mode = 'auto' WHERE id = 1");
    const forced = await addCampaign(client, "Forced review", "review");
    await enroll(client, forced, await addContact(client, "bea@acme.test", { first: "Bea" }));
    const next = await planDay(client, { etDate: "2026-10-23", now: new Date("2026-10-23T13:00:00.000Z"), rng: () => 0 });
    expect(next.drafted).toBe(1);

    const inbox = await client.query<{ id: string }>("SELECT id FROM inboxes WHERE email = 'divyam@usefigcel.com'");
    const stopped = await stopFromInbound(client, {
      inboxId: inbox.rows[0].id,
      gmailMessageId: "inbound-1",
      fromEmail: "Ada <ada@acme.test>",
      subject: "Re: Hi",
      bodyText: "Please unsubscribe me",
      now: SEND_AT,
    });
    expect(stopped.stopped).toBe(1);
    const enrollment = await client.query<{ status: string; stop_reason: string }>(
      "SELECT status, stop_reason FROM enrollments WHERE id = $1",
      [enrollmentId],
    );
    expect(enrollment.rows[0]).toMatchObject({ status: "stopped", stop_reason: "unsubscribe" });

    const toReview = await setApprovalMode(client, { scope: "global", mode: "review", source: "ui", actor: "divyam" });
    expect(toReview.changed).toBe(true);
    const toAuto = await setApprovalMode(client, { scope: "global", mode: "auto", source: "ui", actor: "divyam" });
    expect(toAuto.changed).toBe(true);
    await setApprovalMode(client, { scope: "global", mode: "review", source: "ui", actor: "divyam" });
    const audits = await client.query("SELECT action, source FROM audit_log WHERE action = 'approval.change'");
    expect(audits.rows).toHaveLength(3);
    expect(audits.rows.every((row) => row.source === "ui")).toBe(true);

    await expect(updateStopThresholds(client, { next: { hardBouncePct: 3 }, source: "ui", actor: "divyam" })).rejects.toThrow(
      /explicit reason/,
    );
    await updateStopThresholds(client, {
      next: { hardBouncePct: 3 },
      source: "ui",
      actor: "divyam",
      reason: "owner accepted a wider bounce band for this week",
    });
    const stored = await loadSendSettings(client);
    expect(stored.thresholds.hardBouncePct).toBe(3);
    const override = await client.query("SELECT reason FROM threshold_overrides");
    expect(override.rows[0].reason).toMatch(/wider bounce/);
  });
});

it("approves a draft without calling the adapter while the kill switch is off", async () => {
  await withClient(async (client) => {
    await openGates(client, "review");
    const campaignId = await addCampaign(client, "Approve pilot");
    await enroll(client, campaignId, await addContact(client, "ada@acme.test"));
    await planDay(client, { etDate: ET_DAY, now: PLAN_AT, rng: () => 0 });
    const draft = await client.query<{ id: string }>("SELECT id FROM review_drafts");
    const { adapter, calls } = recorder();
    const decided = await decideDraft(client, {
      id: draft.rows[0].id,
      action: "approve",
      actor: "divyam",
      source: "ui",
      adapter,
      now: SEND_AT,
      sendingEnabled: false,
      sendMode: "live",
    });
    expect(decided.ok).toBe(true);
    if (decided.ok) expect(decided.send?.outcome).toBe("deferred");
    expect(calls).toHaveLength(0);
    expect(etDateISO(SEND_AT)).toBe(ET_DAY);
  });
});
