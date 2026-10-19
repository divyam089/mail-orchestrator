import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { INBOXES } from "@/lib/inboxes";
import { literalEmail, normalizeEmail } from "@/lib/email/normalize";
import { importContact } from "@/lib/contacts/import";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { reserveSend } from "@/lib/sends/reserve";
import { EMAIL_CASES } from "./email-cases";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) {
  throw new Error("DATABASE_URL_TEST is not set");
}

const pool = new Pool({ connectionString });

beforeAll(async () => {
  const first = await migrate(connectionString);
  const second = await migrate(connectionString);
  expect(second).toEqual([]);
  expect(first.every((version) => version.length > 0)).toBe(true);
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

function pgError(error: unknown): { code?: string; constraint?: string } {
  return error as { code?: string; constraint?: string };
}

it("agrees with SQL normalize_email on every fixture", async () => {
  for (const item of EMAIL_CASES) {
    const row = await pool.query<{ literal: string | null; normalized: string | null }>(
      "SELECT literal_email($1) AS literal, normalize_email($1) AS normalized",
      [item.input],
    );
    expect(row.rows[0].literal, item.input).toBe(literalEmail(item.input));
    expect(row.rows[0].normalized, item.input).toBe(normalizeEmail(item.input));
    expect(row.rows[0].literal).toBe(item.literal);
    expect(row.rows[0].normalized).toBe(item.normalized);
  }
  const empty = await pool.query("SELECT normalize_email(NULL) AS normalized");
  expect(empty.rows[0].normalized).toBeNull();
});

it("seeds review-mode settings, the hard caps, and the 15 inboxes", async () => {
  const settings = await pool.query<{
    approval_mode: string;
    max_per_inbox: number;
    max_total: number;
    legal_name: string;
    postal_address: string;
    verification_provider: string;
    hosting: string;
  }>("SELECT * FROM app_settings WHERE id = 1");
  expect(settings.rows).toHaveLength(1);
  expect(settings.rows[0].approval_mode).toBe("review");
  expect(settings.rows[0].max_per_inbox).toBe(27);
  expect(settings.rows[0].max_total).toBe(405);
  expect(settings.rows[0].legal_name).toBe("TODO: legal name");
  expect(settings.rows[0].postal_address).toBe("TODO: postal address");
  expect(settings.rows[0].verification_provider).toBe("TODO: verification provider");
  expect(settings.rows[0].hosting).toBe("TODO: hosting");

  const inboxes = await pool.query<{ email: string; sender_name: string; status: string }>(
    "SELECT email, sender_name, status FROM inboxes ORDER BY email",
  );
  expect(inboxes.rows.map((row) => row.email).sort()).toEqual(INBOXES.map((row) => row.email).sort());
  expect(inboxes.rows.every((row) => row.status === "not_connected")).toBe(true);
  for (const inbox of INBOXES) {
    const row = inboxes.rows.find((item) => item.email === inbox.email);
    expect(row?.sender_name).toBe(inbox.senderName);
  }
});

it("rejects caps and ramp values above the hard limit, and real-recipient placement", async () => {
  await withClient(async (client) => {
    await expect(client.query("UPDATE app_settings SET max_per_inbox = 28 WHERE id = 1")).rejects.toMatchObject({
      code: "23514",
    });
  });
  await withClient(async (client) => {
    await expect(client.query("UPDATE app_settings SET max_total = 406 WHERE id = 1")).rejects.toMatchObject({
      code: "23514",
    });
  });
  await withClient(async (client) => {
    await expect(
      client.query("UPDATE app_settings SET ramp = '[[null, 50]]'::jsonb WHERE id = 1"),
    ).rejects.toMatchObject({ code: "23514" });
  });
  await withClient(async (client) => {
    const inbox = await client.query<{ id: string }>("SELECT id FROM inboxes LIMIT 1");
    await expect(
      client.query(
        `INSERT INTO seed_tests (inbox_id, tested_at, et_date, inbox_placement_pct, measurement)
         VALUES ($1, now(), '2026-10-22', 90, 'real_recipient')`,
        [inbox.rows[0].id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

it("imports the same person in different forms as one contact and one enrollment", async () => {
  await withClient(async (client) => {
    const campaign = await client.query<{ id: string }>(
      "INSERT INTO campaigns (name) VALUES ('October sequence') RETURNING id, track_opens, track_clicks, approval_override",
    );
    const created = await client.query<{ track_opens: boolean; track_clicks: boolean; approval_override: string | null }>(
      "SELECT track_opens, track_clicks, approval_override FROM campaigns WHERE id = $1",
      [campaign.rows[0].id],
    );
    expect(created.rows[0]).toMatchObject({
      track_opens: false,
      track_clicks: false,
      approval_override: null,
    });

    const batch = await client.query<{ id: string }>(
      "INSERT INTO imports (source, label) VALUES ('csv', 'fixture') RETURNING id",
    );
    const importId = batch.rows[0].id;
    const campaignId = campaign.rows[0].id;

    const first = await importContact(client, {
      email: "John.Doe+sales@gmail.com",
      firstName: "John",
      source: "csv",
      campaignId,
      importId,
      lineNumber: 1,
    });
    const second = await importContact(client, {
      email: "johndoe@gmail.com",
      source: "paste",
      campaignId,
      importId,
      lineNumber: 2,
    });
    const third = await importContact(client, {
      email: "  JOHNDOE@googlemail.com ",
      source: "api",
      campaignId,
      importId,
      lineNumber: 3,
    });
    const invalid = await importContact(client, {
      email: "not-an-email",
      source: "csv",
      importId,
      lineNumber: 4,
    });

    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(first.contactId).toBe(second.contactId);
    expect(second.contactId).toBe(third.contactId);
    expect(first.normalizedEmail).toBe("johndoe@gmail.com");
    expect(invalid).toEqual({ ok: false, reason: "invalid_email", raw: "not-an-email" });

    const contacts = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts");
    const aliases = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM contact_aliases WHERE contact_id = $1",
      [first.contactId],
    );
    const enrollments = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM enrollments WHERE campaign_id = $1",
      [campaignId],
    );
    const rows = await client.query<{ outcome: string }>(
      "SELECT outcome FROM import_rows WHERE import_id = $1 ORDER BY line_number",
      [importId],
    );
    expect(contacts.rows[0].n).toBe(1);
    expect(aliases.rows[0].n).toBe(3);
    expect(enrollments.rows[0].n).toBe(1);
    expect(rows.rows.map((row) => row.outcome)).toEqual(["created", "duplicate", "duplicate", "invalid"]);

    const dotted = await importContact(client, {
      email: "ada.lovelace@company.com",
      source: "csv",
    });
    const undotted = await importContact(client, {
      email: "adalovelace@company.com",
      source: "csv",
    });
    if (!dotted.ok || !undotted.ok) throw new Error("expected valid company addresses");
    expect(dotted.contactId).not.toBe(undotted.contactId);
    const after = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts");
    expect(after.rows[0].n).toBe(3);
  });
});

it("rejects a second prospect send for the same contact, campaign, and step", async () => {
  await withClient(async (client) => {
    const inbox = await client.query<{ id: string }>(
      "SELECT id FROM inboxes WHERE email = 'divyam@usefigcel.com'",
    );
    const campaignA = await client.query<{ id: string }>(
      "INSERT INTO campaigns (name) VALUES ('A') RETURNING id",
    );
    const campaignB = await client.query<{ id: string }>(
      "INSERT INTO campaigns (name) VALUES ('B') RETURNING id",
    );
    const imported = await importContact(client, {
      email: "Jane Roe <jane.roe+list@gmail.com>",
      source: "ui",
      campaignId: campaignA.rows[0].id,
    });
    if (!imported.ok) throw new Error("import failed");

    const insert = `INSERT INTO sends (
        contact_id, campaign_id, step_number, inbox_id, kind, et_date, state
      ) VALUES ($1, $2, $3, $4, 'prospect', '2026-10-22', 'reserved')`;
    const params = [imported.contactId, campaignA.rows[0].id, 1, inbox.rows[0].id];
    await client.query(insert, params);

    await client.query("SAVEPOINT duplicate_send");
    try {
      await client.query(insert, params);
      throw new Error("duplicate send insert was accepted");
    } catch (error) {
      const pg = pgError(error);
      expect(pg.code).toBe("23505");
      expect(pg.constraint).toBe("sends_prospect_once");
      await client.query("ROLLBACK TO SAVEPOINT duplicate_send");
    }

    const reserved = await reserveSend(client, {
      contactId: imported.contactId,
      campaignId: campaignA.rows[0].id,
      stepNumber: 1,
      inboxId: inbox.rows[0].id,
      etDate: "2026-10-22",
    });
    expect(reserved).toEqual({ ok: false, reason: "duplicate" });

    const stepTwo = await reserveSend(client, {
      contactId: imported.contactId,
      campaignId: campaignA.rows[0].id,
      stepNumber: 2,
      inboxId: inbox.rows[0].id,
      etDate: "2026-10-22",
    });
    const otherCampaign = await reserveSend(client, {
      contactId: imported.contactId,
      campaignId: campaignB.rows[0].id,
      stepNumber: 1,
      inboxId: inbox.rows[0].id,
      etDate: "2026-10-22",
    });
    expect(stepTwo.ok).toBe(true);
    expect(otherCampaign.ok).toBe(true);

    const count = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sends");
    expect(count.rows[0].n).toBe(3);

    await client.query("SAVEPOINT bad_normalized");
    try {
      await client.query(
        `INSERT INTO contacts (display_email, normalized_email, domain)
         VALUES ('John.Doe+sales@gmail.com', 'john.doe+sales@gmail.com', 'gmail.com')`,
      );
      throw new Error("un-normalized contact was accepted");
    } catch (error) {
      expect(pgError(error).code).toBe("23514");
      await client.query("ROLLBACK TO SAVEPOINT bad_normalized");
    }
  });
});
