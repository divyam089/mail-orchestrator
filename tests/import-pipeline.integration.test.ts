import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { importLeads } from "@/lib/contacts/import";
import { mapCsv, parsePaste } from "@/lib/contacts/parse-leads";
import { decideHold } from "@/lib/contacts/holds";
import { DnsLookupError, type DnsResolver, type MxRecord } from "@/lib/verify/dns";
import type { VerificationAdapter } from "@/lib/verify/adapter";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });

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

class FakeDns implements DnsResolver {
  readonly calls: string[] = [];
  mx = new Map<string, MxRecord[] | DnsLookupError>();

  pass(domain: string) {
    this.mx.set(domain, [{ exchange: `mx.${domain}`, priority: 10 }]);
  }

  async resolveMx(domain: string): Promise<MxRecord[]> {
    this.calls.push(`mx ${domain}`);
    const value = this.mx.get(domain);
    if (!value) throw new DnsLookupError("ENODATA", domain);
    if (value instanceof DnsLookupError) throw value;
    return value;
  }

  async resolve4(domain: string): Promise<string[]> {
    this.calls.push(`a ${domain}`);
    if (domain === "implicit.test") return ["203.0.113.9"];
    throw new DnsLookupError("ENODATA", domain);
  }

  async resolve6(domain: string): Promise<string[]> {
    this.calls.push(`aaaa ${domain}`);
    throw new DnsLookupError("ENODATA", domain);
  }
}

function passingDns(): FakeDns {
  const dns = new FakeDns();
  for (const domain of ["gmail.com", "googlemail.com", "acme.test", "policy.test", "off.test", "vendor.test", "role.test", "mailinator.com", "kept.test"]) {
    dns.pass(domain);
  }
  dns.mx.set("nowhere.test", [{ exchange: ".", priority: 0 }]);
  dns.mx.set("slow.test", new DnsLookupError("ETIMEOUT", "timed out"));
  return dns;
}

it("imports the same contact from CSV, paste, and the API function as one record", async () => {
  await withClient(async (client) => {
    const dns = passingDns();
    const csv = mapCsv("email,first,plan\nJohn.Doe+sales@gmail.com,John,gold\n", {
      email: "email",
      firstName: "first",
      custom: { plan: "plan" },
    });
    const first = await importLeads(client, {
      source: "csv",
      records: csv,
      mapping: { email: "email", firstName: "first", custom: { plan: "plan" } },
      tags: ["Sheet"],
      resolver: dns,
    });
    const pasted = parsePaste("johndoe@gmail.com\n");
    const second = await importLeads(client, {
      source: "paste",
      records: pasted,
      tags: ["paste"],
      resolver: dns,
    });
    const third = await importLeads(client, {
      source: "api",
      records: [{ email: "  JOHNDOE@googlemail.com ", title: "Poet", lineNumber: 1 }],
      resolver: dns,
    });

    expect(first.counts).toMatchObject({ new: 1, duplicate_in_file: 0, already_in_system: 0, invalid: 0, suppressed: 0 });
    expect(second.counts.already_in_system).toBe(1);
    expect(third.counts.already_in_system).toBe(1);
    expect(first.rows[0].verificationStatus).toBe("unknown");
    expect(first.rows[0].enrolled).toBe(false);
    expect(first.rows[0].held).toBe(true);

    const contacts = await client.query<{ id: string; first_name: string; title: string; custom_fields: { plan?: string }; n: number }>(
      `SELECT id, first_name, title, custom_fields, count(*) OVER ()::int AS n
       FROM contacts WHERE normalized_email = 'johndoe@gmail.com'`,
    );
    expect(contacts.rows).toHaveLength(1);
    expect(contacts.rows[0].n).toBe(1);
    expect(contacts.rows[0]).toMatchObject({ first_name: "John", title: "Poet", custom_fields: { plan: "gold" } });
    const aliases = await client.query<{ literal_email: string }>(
      "SELECT literal_email FROM contact_aliases WHERE contact_id = $1 ORDER BY literal_email",
      [contacts.rows[0].id],
    );
    expect(aliases.rows.map((row) => row.literal_email)).toEqual([
      "john.doe+sales@gmail.com",
      "johndoe@gmail.com",
      "johndoe@googlemail.com",
    ]);
    const tags = await client.query<{ name: string }>(
      `SELECT t.name FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id
       WHERE ct.contact_id = $1 ORDER BY t.name`,
      [contacts.rows[0].id],
    );
    expect(tags.rows.map((row) => row.name)).toEqual(["paste", "sheet"]);
    const people = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM contacts WHERE normalized_email IN ('ada.lovelace@company.test', 'adalovelace@company.test')",
    );
    const dotted = passingDns();
    await importLeads(client, {
      source: "paste",
      records: parsePaste("ada.lovelace@company.test\nadalovelace@company.test"),
      resolver: dotted,
    });
    const after = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM contacts WHERE domain = 'company.test'",
    );
    expect(people.rows[0].n).toBe(0);
    expect(after.rows[0].n).toBe(2);
  });
});

it("counts duplicates, invalid syntax, suppression, and a second file occurrence once", async () => {
  await withClient(async (client) => {
    await client.query(
      "INSERT INTO suppression (kind, value, reason) VALUES ('domain', 'blocked.test', 'do-not-contact'), ('email', 'johndoe@gmail.com', 'unsubscribed')",
    );
    const dns = passingDns();
    const report = await importLeads(client, {
      source: "paste",
      records: parsePaste(
        ["Jane Doe <jane.doe+a@gmail.com>", "jane.doe@gmail.com", "not-an-email", "John.Doe+sales@gmail.com", "a@blocked.test"].join(
          "\n",
        ),
      ),
      resolver: dns,
    });
    expect(report.counts).toEqual({
      new: 1,
      duplicate_in_file: 1,
      already_in_system: 0,
      invalid: 1,
      suppressed: 2,
    });
    expect(report.counts.new + report.counts.duplicate_in_file + report.counts.already_in_system + report.counts.invalid + report.counts.suppressed).toBe(
      report.rows.length,
    );
    const contacts = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM contacts");
    expect(contacts.rows[0].n).toBe(1);
    const aliases = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM contact_aliases");
    expect(aliases.rows[0].n).toBe(2);
    expect(dns.calls.filter((call) => call.startsWith("mx "))).toHaveLength(1);
  });
});

it("classifies null MX, missing records, implicit addresses, and timeouts without a network call", async () => {
  await withClient(async (client) => {
    const dns = passingDns();
    dns.mx.set("implicit.test", new DnsLookupError("ENODATA", "no mx"));
    const report = await importLeads(client, {
      source: "paste",
      records: parsePaste("a@nowhere.test\nb@missing.test\nc@implicit.test\nd@slow.test"),
      resolver: dns,
    });
    const byRaw = new Map(report.rows.map((row) => [row.raw, row]));
    expect(byRaw.get("a@nowhere.test")).toMatchObject({ bucket: "invalid", verificationStatus: "invalid" });
    expect(byRaw.get("b@missing.test")).toMatchObject({ bucket: "invalid", verificationStatus: "invalid" });
    expect(byRaw.get("c@implicit.test")).toMatchObject({ bucket: "new", verificationStatus: "unknown" });
    expect(byRaw.get("d@slow.test")).toMatchObject({ bucket: "new", verificationStatus: "unknown", held: true });
    expect(dns.calls).not.toContain("a nowhere.test");
    expect(dns.calls).not.toContain("a slow.test");
    expect(dns.calls).toContain("a implicit.test");
    const results = await client.query<{ mx_ok: boolean | null; raw: { mx: { via: string } } }>(
      `SELECT mx_ok, raw FROM verification_results vr
       JOIN contacts c ON c.id = vr.contact_id
       WHERE c.normalized_email = 'c@implicit.test'`,
    );
    expect(results.rows[0].mx_ok).toBe(true);
    expect(results.rows[0].raw.mx.via).toBe("implicit-address");
  });
});

it("holds role and disposable addresses and enrolls only a valid one", async () => {
  await withClient(async (client) => {
    const campaign = await client.query<{ id: string }>("INSERT INTO campaigns (name) VALUES ('October') RETURNING id");
    const dns = passingDns();
    const adapter: VerificationAdapter = {
      provider: "test-vendor",
      async verify(email: string) {
        if (email.startsWith("bad@")) return { provider: "test-vendor", status: "invalid", reason: "vendor says no" };
        return { provider: "test-vendor", status: "valid", reason: "vendor says yes" };
      },
    };
    const report = await importLeads(client, {
      source: "api",
      records: [
        { email: "good@vendor.test", lineNumber: 1 },
        { email: "info@vendor.test", lineNumber: 2 },
        { email: "bad@vendor.test", lineNumber: 3 },
        { email: "person@mailinator.com", lineNumber: 4 },
      ],
      campaignId: campaign.rows[0].id,
      resolver: dns,
      adapter,
    });
    const byRaw = new Map(report.rows.map((row) => [row.raw, row]));
    expect(byRaw.get("good@vendor.test")).toMatchObject({ bucket: "new", verificationStatus: "valid", enrolled: true, held: false });
    expect(byRaw.get("info@vendor.test")).toMatchObject({ verificationStatus: "risky", enrolled: false, held: true });
    expect(byRaw.get("bad@vendor.test")).toMatchObject({ bucket: "invalid", verificationStatus: "invalid", enrolled: false, held: false });
    expect(byRaw.get("person@mailinator.com")).toMatchObject({ verificationStatus: "risky", held: true, enrolled: false });
    const enrollments = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments");
    expect(enrollments.rows[0].n).toBe(1);
    const holds = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM verification_holds WHERE status = 'pending'",
    );
    expect(holds.rows[0].n).toBe(2);
  });
});

it("keeps MX-pass unknown until the owner policy is on, then enrolls", async () => {
  await withClient(async (client) => {
    const campaign = await client.query<{ id: string }>("INSERT INTO campaigns (name) VALUES ('Policy') RETURNING id");
    const off = await importLeads(client, {
      source: "paste",
      records: parsePaste("ada@off.test"),
      campaignId: campaign.rows[0].id,
      resolver: passingDns(),
    });
    expect(off.rows[0]).toMatchObject({ verificationStatus: "unknown", enrolled: false, held: true });

    await client.query("UPDATE app_settings SET treat_mx_pass_as_valid = true WHERE id = 1");
    const on = await importLeads(client, {
      source: "paste",
      records: parsePaste("ada@policy.test"),
      campaignId: campaign.rows[0].id,
      resolver: passingDns(),
    });
    expect(on.rows[0]).toMatchObject({ verificationStatus: "valid", enrolled: true, held: false });
    const flag = await client.query<{ treat_mx_pass_as_valid: boolean }>(
      "SELECT treat_mx_pass_as_valid FROM app_settings WHERE id = 1",
    );
    expect(flag.rows[0].treat_mx_pass_as_valid).toBe(true);
  });
});

it("does not clear a valid contact on a later import with no provider", async () => {
  await withClient(async (client) => {
    await client.query("UPDATE app_settings SET treat_mx_pass_as_valid = true WHERE id = 1");
    const dns = passingDns();
    await importLeads(client, { source: "paste", records: parsePaste("ada@kept.test"), resolver: dns });
    await client.query("UPDATE app_settings SET treat_mx_pass_as_valid = false WHERE id = 1");
    const again = await importLeads(client, { source: "paste", records: parsePaste("Ada <ada@kept.test>"), resolver: dns });
    expect(again.rows[0]).toMatchObject({ bucket: "already_in_system", verificationStatus: "valid", enrolled: false });
    const aliases = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM contact_aliases a
       JOIN contacts c ON c.id = a.contact_id WHERE c.normalized_email = 'ada@kept.test'`,
    );
    expect(aliases.rows[0].n).toBe(1);
  });
});

it("does not downgrade a valid contact when DNS times out", async () => {
  await withClient(async (client) => {
    await client.query("UPDATE app_settings SET treat_mx_pass_as_valid = true WHERE id = 1");
    const dns = passingDns();
    await importLeads(client, { source: "paste", records: parsePaste("ada@kept.test"), resolver: dns });
    dns.mx.set("kept.test", new DnsLookupError("ETIMEOUT", "timed out"));
    const again = await importLeads(client, { source: "paste", records: parsePaste("ada@kept.test"), resolver: dns });
    expect(again.rows[0]).toMatchObject({ bucket: "already_in_system", verificationStatus: "valid" });
  });
});

it("logs approve and reject, and enrolls only the approval", async () => {
  await withClient(async (client) => {
    const campaign = await client.query<{ id: string }>("INSERT INTO campaigns (name) VALUES ('Hold') RETURNING id");
    const dns = passingDns();
    const report = await importLeads(client, {
      source: "paste",
      records: parsePaste("one@acme.test\ntwo@acme.test"),
      campaignId: campaign.rows[0].id,
      resolver: dns,
    });
    expect(report.rows.every((row) => row.held && !row.enrolled)).toBe(true);
    const holds = await client.query<{ id: string; email: string }>(
      `SELECT h.id, c.normalized_email AS email
       FROM verification_holds h JOIN contacts c ON c.id = h.contact_id
       ORDER BY c.normalized_email`,
    );
    const approved = await decideHold(client, { holdId: holds.rows[0].id, action: "approve", actor: "operator", source: "ui" });
    const rejected = await decideHold(client, { holdId: holds.rows[1].id, action: "reject", actor: "operator", source: "ui" });
    expect(approved).toMatchObject({ ok: true, status: "approved", enrolled: true });
    expect(rejected).toMatchObject({ ok: true, status: "rejected", enrolled: false });
    const again = await decideHold(client, { holdId: holds.rows[0].id, action: "approve", actor: "operator", source: "ui" });
    expect(again).toEqual({ ok: false, reason: "not_pending" });

    const enrollments = await client.query<{ email: string }>(
      `SELECT c.normalized_email AS email FROM enrollments e JOIN contacts c ON c.id = e.contact_id`,
    );
    expect(enrollments.rows.map((row) => row.email)).toEqual(["one@acme.test"]);
    const statuses = await client.query<{ email: string; verification_status: string }>(
      "SELECT normalized_email AS email, verification_status FROM contacts ORDER BY normalized_email",
    );
    expect(statuses.rows).toEqual([
      { email: "one@acme.test", verification_status: "valid" },
      { email: "two@acme.test", verification_status: "unknown" },
    ]);
    const audit = await client.query<{ action: string; source: string; actor: string }>(
      "SELECT action, source, actor FROM audit_log ORDER BY id",
    );
    expect(audit.rows).toEqual([
      { action: "hold.approve", source: "ui", actor: "operator" },
      { action: "hold.reject", source: "ui", actor: "operator" },
    ]);
  });
});
