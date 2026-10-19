import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { signValue, readSigned } from "@/lib/auth/cookie";
import { requireApi } from "@/lib/auth/guard";
import { oidcProvider, setOidcProvider, type OidcProvider } from "@/lib/auth/google";
import { setSessionLoader, loadSessionById, openSession, revokeAllSessions, type SessionUser } from "@/lib/auth/session";
import {
  acceptIdentity,
  acceptPassword,
  bootstrapAdmin,
  changeRole,
  consumeMagicLink,
  finishSignIn,
  inviteUser,
  issueMagicLink,
  removeUser,
  setLoginRestricted,
  setMagicDelivery,
} from "@/lib/auth/users";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { AuthError } from "@/lib/auth/errors";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
});

afterEach(() => {
  setSessionLoader(null);
  setOidcProvider(null);
  setMagicDelivery(null);
  delete process.env.LOCAL_LOGIN_ENABLED;
  delete process.env.BOOTSTRAP_ADMIN_EMAIL;
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

it("rejects an uninvited Google identity and records the actor", async () => {
  await withClient(async (client) => {
    await expect(
      acceptIdentity(client, { email: "stranger@example.test", emailVerified: true, sub: "sub-1", name: "Stranger" }),
    ).rejects.toMatchObject({ status: 403, message: "That account has not been invited" });
    const audit = await client.query<{ actor: string; action: string }>(
      `SELECT actor, action FROM audit_log WHERE action = 'auth.rejected' AND actor = 'user:stranger@example.test'`,
    );
    expect(audit.rows).toHaveLength(1);
  });
});

it("signs an invited account in once and audits user:email", async () => {
  await withClient(async (client) => {
    const invited = await inviteUser(client, { email: "Ada@Usefigcel.com", role: "operator", actor: "user:owner@usefigcel.com" });
    const accepted = await acceptIdentity(client, {
      email: "ada@usefigcel.com",
      emailVerified: true,
      sub: "google-ada",
      name: "Ada Maru",
    });
    const session = await finishSignIn(client, accepted.userId, invited.email);
    const rows = await client.query(`SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [accepted.userId]);
    expect(rows.rows).toHaveLength(1);
    const loaded = await loadSessionById(client, session.sessionId);
    expect(loaded?.actor).toBe("user:ada@usefigcel.com");
    expect(loaded?.role).toBe("operator");
    const audit = await client.query<{ actor: string }>(
      `SELECT actor FROM audit_log WHERE action = 'auth.sign_in' AND entity_id = $1`,
      [accepted.userId],
    );
    expect(audit.rows[0]?.actor).toBe("user:ada@usefigcel.com");
    const name = await client.query<{ name: string }>(`SELECT name FROM users WHERE id = $1`, [accepted.userId]);
    expect(name.rows[0].name).toBe("Ada Maru");
  });
});

it("limits sign-in to the five domains only when the setting is on", async () => {
  await withClient(async (client) => {
    await inviteUser(client, { email: "partner@example.test", role: "viewer", actor: "user:owner@usefigcel.com" });
    await setLoginRestricted(client, true, "user:owner@usefigcel.com");
    await expect(inviteUser(client, { email: "other@example.test", role: "viewer", actor: "user:owner@usefigcel.com" })).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      acceptIdentity(client, { email: "partner@example.test", emailVerified: true, sub: "x", name: "Partner" }),
    ).rejects.toMatchObject({ status: 403 });
    const inside = await inviteUser(client, { email: "piyush@hellofigcel.com", role: "viewer", actor: "user:owner@usefigcel.com" });
    const accepted = await acceptIdentity(client, {
      email: "piyush@hellofigcel.com",
      emailVerified: true,
      sub: "in",
      name: "Piyush",
    });
    expect(accepted.userId).toBe(inside.id);
    await setLoginRestricted(client, false, "user:owner@usefigcel.com");
    const open = await acceptIdentity(client, { email: "partner@example.test", emailVerified: true, sub: "y", name: "Partner" });
    expect(open.userId).toBeTruthy();
  });
});

it("keeps password and magic-link sign-in off unless the flag is exactly true", async () => {
  const password = await import("@/app/api/auth/password/route");
  const magic = await import("@/app/api/auth/magic/route");
  const off = await password.POST(new Request("http://127.0.0.1/api/auth/password", { method: "POST", body: "{}" }));
  expect(off.status).toBe(404);
  const magicOff = await magic.POST(new Request("http://127.0.0.1/api/auth/magic", { method: "POST", body: "{}" }));
  expect(magicOff.status).toBe(404);
  expect(oidcProvider().configured()).toBe(false);
  await expect(
    oidcProvider().exchangeCode({ code: "nope", redirectUri: "http://127.0.0.1/api/auth/google/callback", nonce: "n" }),
  ).rejects.toThrow(/TODO: GOOGLE_OIDC_CLIENT_ID/);
});

it("accepts a password and a single-use magic link without sending mail", async () => {
  await withClient(async (client) => {
    await inviteUser(client, {
      email: "local@usefigcel.com",
      role: "operator",
      actor: "user:owner@usefigcel.com",
      password: "correct horse",
    });
    await expect(acceptPassword(client, "local@usefigcel.com", "wrong")).rejects.toMatchObject({ status: 401 });
    const ok = await acceptPassword(client, "local@usefigcel.com", "correct horse");
    expect(ok.userId).toBeTruthy();
    let captured = "";
    setMagicDelivery(async ({ url }) => {
      captured = url;
    });
    await issueMagicLink(client, new Request("http://127.0.0.1/api/auth/magic"), "local@usefigcel.com");
    const token = new URL(captured).searchParams.get("token") ?? "";
    expect(token).not.toBe("");
    expect(captured.startsWith("http://127.0.0.1/api/auth/magic/consume")).toBe(true);
    const first = await consumeMagicLink(client, token);
    expect(first.userId).toBe(ok.userId);
    await expect(consumeMagicLink(client, token)).rejects.toMatchObject({ status: 401 });
    const issued = await client.query(`SELECT action, detail FROM audit_log WHERE action = 'auth.magic_issued'`);
    expect(JSON.stringify(issued.rows)).not.toContain(token);
    expect(JSON.stringify(issued.rows)).toContain("TODO: mailer");
  });
});

it("refuses to remove or demote the last admin, and sign-out everywhere revokes every session", async () => {
  await withClient(async (client) => {
    const admin = await inviteUser(client, { email: "owner@usefigcel.com", role: "admin", actor: "user:system" });
    const partner = await inviteUser(client, { email: "partner@tryfigcel.com", role: "operator", actor: "user:owner@usefigcel.com" });
    await expect(removeUser(client, { userId: admin.id, actor: "user:owner@usefigcel.com" })).rejects.toBeInstanceOf(AuthError);
    await expect(changeRole(client, { userId: admin.id, role: "viewer", actor: "user:owner@usefigcel.com" })).rejects.toMatchObject({
      status: 409,
    });
    const first = await openSession(client, partner.id);
    const second = await openSession(client, partner.id);
    await revokeAllSessions(client, partner.id);
    expect(await loadSessionById(client, first.sessionId)).toBeNull();
    expect(await loadSessionById(client, second.sessionId)).toBeNull();
    const kept = await openSession(client, admin.id);
    await client.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [kept.sessionId]);
    expect(await loadSessionById(client, kept.sessionId)).toBeNull();
  });
});

it("rejects a missing CSRF token and a forged session cookie", async () => {
  const user: SessionUser = {
    id: "00000000-0000-4000-8000-000000000010",
    email: "owner@usefigcel.com",
    name: "Owner",
    role: "admin",
    csrf: "csrf-token",
    sessionId: "00000000-0000-4000-8000-000000000011",
    actor: "user:owner@usefigcel.com",
  };
  setSessionLoader(async () => user);
  await expect(
    requireApi(new Request("http://127.0.0.1/api/team", { method: "POST" }), "admin"),
  ).rejects.toMatchObject({ status: 403 });
  expect(readSigned("forged.signature")).toBeNull();
  expect(readSigned(signValue("session-id"))).toBe("session-id");
});

it("bootstraps the first admin from the environment and does not add a second", async () => {
  await withClient(async (client) => {
    await client.query("DELETE FROM users");
    process.env.BOOTSTRAP_ADMIN_EMAIL = "divyam@usefigcel.com";
    await bootstrapAdmin(client);
    await bootstrapAdmin(client);
    const admins = await client.query<{ email: string; status: string }>(
      `SELECT email, status FROM users WHERE role = 'admin' AND status <> 'removed'`,
    );
    expect(admins.rows).toEqual([{ email: "divyam@usefigcel.com", status: "invited" }]);
  });
});

it("uses a fake Google provider and does not call the network", async () => {
  const fake: OidcProvider = {
    configured: () => true,
    authorizationUrl: ({ state }) => `https://example.test/auth?state=${state}`,
    exchangeCode: async ({ nonce }) => ({
      email: "ada@usefigcel.com",
      emailVerified: true,
      sub: "fake-sub",
      name: "Ada",
      nonce,
    }),
  };
  setOidcProvider(fake);
  const start = await import("@/app/api/auth/google/route");
  const response = await start.GET(new Request("http://127.0.0.1/api/auth/google"));
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  const location = response.headers.get("location") ?? "";
  expect(location.startsWith("https://example.test/auth?state=")).toBe(true);
  expect(location).not.toContain("accounts.google.com");
  const identity = await fake.exchangeCode({ code: "fake", redirectUri: "http://127.0.0.1/cb", nonce: "nonce-1" });
  expect(identity.nonce).toBe("nonce-1");
});
