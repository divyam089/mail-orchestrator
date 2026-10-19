import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { createApiKey } from "@/lib/api/keys";
import { handleApiV1, toApiResult, type ApiCall } from "@/lib/api/handle";
import { presentApiEvent } from "@/lib/api/events";
import { resetRateLimits } from "@/lib/api/rate";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { readSendingEnabled } from "@/lib/gates";
import { evaluateSendGates, type GateSubject } from "@/lib/send/gates";
import { touchKv } from "@/lib/send/settings";
import { etDateISO } from "@/lib/window";
import { ApiError } from "@/lib/api/errors";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });
const INSIDE = new Date("2026-10-19T14:00:00.000Z");
const TOO_EARLY = new Date("2026-10-19T12:00:00.000Z");

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(() => {
  resetRateLimits();
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

function headers(secret?: string, extra: Record<string, string> = {}) {
  const map = new Map<string, string>();
  if (secret) map.set("authorization", `Bearer ${secret}`);
  for (const [name, value] of Object.entries(extra)) map.set(name.toLowerCase(), value);
  return { get: (name: string) => map.get(name.toLowerCase()) ?? null };
}

async function call(
  client: PoolClient,
  secret: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  extra?: Record<string, string>,
  search?: Record<string, string>,
) {
  const input: ApiCall = { method, path, headers: headers(secret, extra), body: body ?? {}, search: new URLSearchParams(search) };
  try {
    return await handleApiV1(client, input);
  } catch (error) {
    return toApiResult(error);
  }
}

async function mint(client: PoolClient, role: "admin" | "operator" | "viewer", name: string, scopes?: string[], rateLimitPerMinute?: number) {
  const created = await createApiKey(client, { name, role, scopes, rateLimitPerMinute });
  return created.secret;
}

it("rejects a missing key and a viewer write", async () => {
  await withClient(async (client) => {
    const missing = await call(client, undefined, "GET", "/campaigns");
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ error: { code: "unauthorized" } });
    const viewer = await mint(client, "viewer", "view");
    const denied = await call(client, viewer, "POST", "/campaigns", { name: "Nope" });
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ error: { code: "forbidden" } });
    const listed = await call(client, viewer, "GET", "/campaigns");
    expect(listed.status).toBe(200);
  });
});

it("records the key name on the audit row and honors scopes", async () => {
  await withClient(async (client) => {
    const secret = await mint(client, "operator", "desk", ["mail.read"]);
    const denied = await call(client, secret, "POST", "/campaigns", { name: "Blocked" });
    expect(denied.status).toBe(403);
    const admin = await mint(client, "admin", "owner");
    const created = await call(client, admin, "POST", "/campaigns", { name: "Harbor API" });
    expect(created.status).toBe(201);
    const audit = await client.query<{ actor: string; action: string }>(
      `SELECT actor, action FROM audit_log WHERE actor = 'api:owner' AND action = 'campaigns.create'`,
    );
    expect(audit.rows.length).toBeGreaterThan(0);
  });
});

it("rate limits a key and revokes it", async () => {
  await withClient(async (client) => {
    const secret = await mint(client, "viewer", "tight", [], 2);
    expect((await call(client, secret, "GET", "/campaigns")).status).toBe(200);
    expect((await call(client, secret, "GET", "/campaigns")).status).toBe(200);
    const limited = await call(client, secret, "GET", "/campaigns");
    expect(limited.status).toBe(429);
    expect(limited.body).toMatchObject({ error: { code: "rate_limited" } });
    const admin = await mint(client, "admin", "revoker", [], 20);
    const keys = await call(client, admin, "GET", "/keys");
    const id = (keys.body as { id: string; name: string }[]).find((row) => row.name === "tight")?.id;
    expect(id).toBeTruthy();
    expect((await call(client, admin, "POST", `/keys/${id}/revoke`)).status).toBe(200);
    expect((await call(client, secret, "GET", "/campaigns")).status).toBe(401);
  });
});

it("replays an idempotent compose and rejects a different body", async () => {
  await withClient(async (client) => {
    const secret = await mint(client, "operator", "composer");
    const body = { inboxEmail: "divyam@usefigcel.com", to: ["ada@example.test"], subject: "Hello", text: "Hello" };
    const first = await call(client, secret, "POST", "/mail/messages", body, { "idempotency-key": "compose-1" });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ outcome: "drafted" });
    const second = await call(client, secret, "POST", "/mail/messages", body, { "idempotency-key": "compose-1" });
    expect(second.body).toEqual(first.body);
    const drafts = await client.query(`SELECT COUNT(*)::text AS n FROM review_drafts WHERE subject = 'Hello'`);
    expect(drafts.rows[0].n).toBe("1");
    const clash = await call(client, secret, "POST", "/mail/messages", { ...body, text: "Different" }, { "idempotency-key": "compose-1" });
    expect(clash.status).toBe(409);
    expect(clash.body).toMatchObject({ error: { code: "idempotency_conflict" } });
    const missing = await call(client, secret, "POST", "/mail/messages", body);
    expect(missing.body).toMatchObject({ error: { code: "idempotency_required" } });
  });
});

it("does not let the body turn sending on or skip review", async () => {
  expect(readSendingEnabled()).toBe(false);
  await withClient(async (client) => {
    const secret = await mint(client, "operator", "gates");
    await client.query("UPDATE app_settings SET approval_mode = 'auto' WHERE id = 1");
    const forced = await call(
      client,
      secret,
      "POST",
      "/mail/messages",
      { inboxEmail: "divyam@usefigcel.com", to: ["ada@example.test"], subject: "Hi", text: "Hi", sendingEnabled: true, sendMode: "live" },
      { "idempotency-key": "force-1" },
    );
    expect(forced.status).toBe(200);
    expect(forced.body).toMatchObject({ outcome: "deferred" });
    expect(JSON.stringify(forced.body)).toContain("dry-run");
    expect(JSON.stringify(forced.body)).not.toContain('"outcome":"sent"');
    const sent = await client.query(`SELECT COUNT(*)::text AS n FROM sends WHERE state = 'sent'`);
    expect(sent.rows[0].n).toBe("0");
  });
});

it("holds a reviewed compose and blocks a suppressed recipient", async () => {
  await withClient(async (client) => {
    const secret = await mint(client, "operator", "suppress");
    await client.query(
      `INSERT INTO suppression (kind, value, reason, source) VALUES ('email', 'blocked@example.test', 'owner', 'test')`,
    );
    const blocked = await call(
      client,
      secret,
      "POST",
      "/mail/messages",
      { inboxEmail: "divyam@usefigcel.com", to: ["blocked@example.test"], subject: "Hi", text: "Hi" },
      { "idempotency-key": "sup-1" },
    );
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ error: { code: "gate_blocked" } });
    const held = await call(
      client,
      secret,
      "POST",
      "/mail/messages",
      { inboxEmail: "divyam@usefigcel.com", to: ["ada@example.test"], subject: "Queue", text: "Hi" },
      { "idempotency-key": "hold-1" },
    );
    expect(held.body).toMatchObject({ outcome: "drafted" });
  });
});

it("uses the shared gate for window, pause, ramp, and fleet cap", async () => {
  await withClient(async (client) => {
    const inbox = await client.query<{ id: string; email: string; domain: string }>(
      `SELECT id, email, domain FROM inboxes WHERE email = 'divyam@usefigcel.com'`,
    );
    const box = inbox.rows[0];
    await client.query(
      `UPDATE app_settings SET legal_name = 'Figcel Inc.', postal_address = '1 Market Street', unsubscribe_https_base = 'https://unsub.test' WHERE id = 1`,
    );
    await client.query(`UPDATE inboxes SET status = 'active' WHERE id = $1`, [box.id]);
    await touchKv(client, "unsub_sync_ok_at", INSIDE);
    await touchKv(client, "poll_ok_at", INSIDE);
    const contact = await client.query<{ id: string }>(
      `INSERT INTO contacts (display_email, normalized_email, domain, timezone, verification_status)
       VALUES ('gate@example.test', 'gate@example.test', 'example.test', 'America/New_York', 'valid') RETURNING id`,
    );
    const base = (): GateSubject => ({
      kind: "prospect",
      to: "gate@example.test",
      contactId: contact.rows[0].id,
      verificationStatus: "valid",
      enrollmentStatus: "active",
      leadTimezone: "America/New_York",
      inbox: { id: box.id, email: box.email, domain: box.domain, status: "active" },
      now: INSIDE,
      sendingEnabled: true,
      sendMode: "live",
      legalName: "Figcel Inc.",
      postalAddress: "1 Market Street",
      unsubscribeHttpsBase: "https://unsub.test",
      maxPerInbox: 27,
      maxTotal: 405,
      ramp: [
        { days: 3, perInbox: 9 },
        { days: 4, perInbox: 18 },
        { days: null, perInbox: 27 },
      ],
      window: { etStart: "09:00", etEnd: "17:00", istStart: "18:30", istEnd: "06:30" },
      thresholds: { hardBouncePct: 2, hardBounceWindow: 200, complaintPausePct: 0.1, complaintHardStopPct: 0.3, seedMinInboxPct: 80, unsubMaxHours: 24 },
    });
    const killed = await evaluateSendGates(client, { ...base(), sendingEnabled: false });
    expect(killed.action === "defer" && killed.reason).toContain("SENDING_ENABLED");
    const early = await evaluateSendGates(client, { ...base(), now: TOO_EARLY });
    expect(early.action).toBe("defer");
    expect(early.action === "defer" && early.reason).toContain("outside ET");

    await client.query(`INSERT INTO pauses (scope, target, rule, detail) VALUES ('inbox', $1, 'manual', 'stop')`, [box.email]);
    const paused = await evaluateSendGates(client, base());
    expect(paused.action === "defer" && paused.reason).toContain("inbox paused");
    await client.query(`UPDATE pauses SET resumed_at = now() WHERE target = $1`, [box.email]);

    const day = etDateISO(INSIDE);
    for (let i = 0; i < 9; i++) {
      await client.query(
        `INSERT INTO sends (inbox_id, kind, seed_address, step_number, et_date, state) VALUES ($1, 'seed', $2, 1, $3::date, 'sent')`,
        [box.id, `seed-${i}@example.test`, day],
      );
    }
    const capped = await evaluateSendGates(client, base());
    expect(capped.action === "defer" && capped.reason).toContain("per-inbox cap reached (9)");

    await client.query(`DELETE FROM sends WHERE inbox_id = $1`, [box.id]);
    await client.query(
      `INSERT INTO sends (inbox_id, kind, seed_address, step_number, et_date, state) VALUES ($1, 'seed', 'only@example.test', 1, $2::date, 'sent')`,
      [box.id, day],
    );
    const fleet = await evaluateSendGates(client, { ...base(), maxTotal: 1 });
    expect(fleet.action === "defer" && fleet.reason).toContain("fleet cap reached");
  });
});

it("imports, suppresses, pauses, and maps assistant events", async () => {
  await withClient(async (client) => {
    const secret = await mint(client, "operator", "ops");
    const imported = await call(client, secret, "POST", "/imports", { source: "paste", text: "not-an-email" });
    expect(imported.status).toBe(201);
    expect(imported.body).toMatchObject({ counts: { invalid: 1 } });
    const added = await call(client, secret, "POST", "/suppression", { kind: "domain", value: "blocked.test", reason: "owner" });
    expect(added.status).toBe(201);
    const inbox = await client.query<{ id: string }>(`SELECT id FROM inboxes WHERE email = 'piyush@usefigcel.com'`);
    const paused = await call(client, secret, "POST", `/inboxes/${inbox.rows[0].id}/pause`, { detail: "API pause", rule: "manual" });
    expect(paused.status).toBe(200);
    const status = await client.query<{ status: string }>(`SELECT status FROM inboxes WHERE id = $1`, [inbox.rows[0].id]);
    expect(status.rows[0].status).toBe("paused");
    const resumed = await call(client, secret, "POST", `/inboxes/${inbox.rows[0].id}/resume`, {});
    expect(resumed.status).toBe(200);
    const reply = await client.query<{ id: string }>(
      `INSERT INTO events (kind, et_date, detail) VALUES ('reply', '2026-10-19', '{}') RETURNING id`,
    );
    const frame = await presentApiEvent(client, {
      id: 1,
      topic: "events",
      entity: "events",
      entityId: reply.rows[0].id,
      happenedAt: INSIDE.toISOString(),
      op: "INSERT",
    });
    expect(frame?.name).toBe("reply.received");
    const csv = await call(client, secret, "GET", "/dashboard/export", {}, undefined, { view: "summary" });
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain("complaints");
    const open = await client.query<{ id: string }>(
      `INSERT INTO events (kind, et_date, detail) VALUES ('open', '2026-10-19', '{}') RETURNING id`,
    );
    expect(
      await presentApiEvent(client, {
        id: 2,
        topic: "events",
        entity: "events",
        entityId: open.rows[0].id,
        happenedAt: INSIDE.toISOString(),
        op: "INSERT",
      }),
    ).toBeNull();
  });
});

it("returns a coded error object", () => {
  const result = toApiResult(new ApiError(409, "gate_blocked", "suppressed"));
  expect(result).toEqual({ status: 409, body: { error: { code: "gate_blocked", message: "suppressed" } } });
});
