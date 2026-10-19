import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";
import { randomToken } from "@/lib/auth/cookie";
import { hashToken, openSession, revokeAllSessions } from "@/lib/auth/session";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { domainAllowed, isRole, normalizeLoginEmail, type Role } from "@/lib/auth/roles";
import { audit } from "@/lib/send/settings";
import { AuthError } from "@/lib/auth/errors";

export type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  last_sign_in_at: string | null;
};

export async function loginRestricted(db: Db): Promise<boolean> {
  const result = await db.query<{ restrict_login_domains: boolean }>(
    "SELECT restrict_login_domains FROM app_settings WHERE id = 1",
  );
  return result.rows[0]?.restrict_login_domains === true;
}

export async function setLoginRestricted(db: Db, restricted: boolean, actor: string): Promise<void> {
  await db.query("UPDATE app_settings SET restrict_login_domains = $1 WHERE id = 1", [restricted]);
  await audit(db, {
    source: "ui",
    actor,
    action: "users.domains",
    entityType: "app_settings",
    entityId: "1",
    detail: { restrict_login_domains: restricted },
  });
}

export async function listUsers(db: Db): Promise<UserRow[]> {
  const result = await db.query<UserRow>(
    `SELECT id, email, name, role, status, last_sign_in_at::text
     FROM users
     WHERE status <> 'removed'
     ORDER BY email`,
  );
  return result.rows.filter((row): row is UserRow => isRole(row.role));
}

async function assertLastAdmin(db: Db, userId: string, nextRole: Role | "removed"): Promise<void> {
  if (nextRole === "admin") return;
  const admins = await db.query<{ id: string }>(
    "SELECT id FROM users WHERE role = 'admin' AND status <> 'removed' AND id <> $1",
    [userId],
  );
  const self = await db.query<{ role: string }>("SELECT role FROM users WHERE id = $1", [userId]);
  if (self.rows[0]?.role === "admin" && admins.rows.length === 0) {
    throw new AuthError(409, "validation", "The last admin cannot be removed or demoted");
  }
}

export async function inviteUser(db: Db, input: { email: string; role: Role; actor: string; password?: string | null }): Promise<UserRow> {
  const email = normalizeLoginEmail(input.email);
  if (!email) throw new AuthError(400, "validation", "Enter a valid email address");
  if (await loginRestricted(db) && !domainAllowed(email, true)) {
    throw new AuthError(400, "validation", "That domain is outside the five Figcel domains");
  }
  const passwordHash = input.password ? await hashPassword(input.password) : null;
  const result = await db.query<UserRow>(
    `INSERT INTO users (email, name, role, status, password_hash)
     VALUES ($1, $1, $2, 'invited', $3)
     ON CONFLICT (email) DO UPDATE
       SET role = EXCLUDED.role,
           status = 'invited',
           password_hash = COALESCE(EXCLUDED.password_hash, users.password_hash)
     RETURNING id, email, name, role, status, last_sign_in_at::text`,
    [email, input.role, passwordHash],
  );
  const row = result.rows[0];
  await audit(db, {
    source: "ui",
    actor: input.actor,
    action: "users.invite",
    entityType: "users",
    entityId: row.id,
    detail: { email, role: input.role },
  });
  return row;
}

export async function changeRole(db: Db, input: { userId: string; role: Role; actor: string }): Promise<void> {
  await assertLastAdmin(db, input.userId, input.role);
  const updated = await db.query("UPDATE users SET role = $2 WHERE id = $1 AND status <> 'removed'", [input.userId, input.role]);
  if ((updated.rowCount ?? 0) === 0) throw new AuthError(404, "validation", "That person is not on the team");
  await audit(db, {
    source: "ui",
    actor: input.actor,
    action: "users.role",
    entityType: "users",
    entityId: input.userId,
    detail: { role: input.role },
  });
}

export async function removeUser(db: Db, input: { userId: string; actor: string }): Promise<void> {
  await assertLastAdmin(db, input.userId, "removed");
  const updated = await db.query("UPDATE users SET status = 'removed' WHERE id = $1 AND status <> 'removed'", [input.userId]);
  if ((updated.rowCount ?? 0) === 0) throw new AuthError(404, "validation", "That person is not on the team");
  await revokeAllSessions(db, input.userId);
  await audit(db, {
    source: "ui",
    actor: input.actor,
    action: "users.remove",
    entityType: "users",
    entityId: input.userId,
    detail: {},
  });
}

type Identity = { email: string; emailVerified: boolean; sub?: string | null; name?: string | null };

export async function acceptIdentity(db: Db, identity: Identity): Promise<{ userId: string }> {
  const email = normalizeLoginEmail(identity.email);
  if (!email) throw new AuthError(401, "unauthorized", "That account has no usable email");
  if (!identity.emailVerified) throw new AuthError(401, "unauthorized", "That email is not verified");
  if (await loginRestricted(db) && !domainAllowed(email, true)) {
    throw new AuthError(403, "forbidden", "That domain is outside the five Figcel domains");
  }
  const found = await db.query<{ id: string; status: string }>(
    "SELECT id, status FROM users WHERE email = $1",
    [email],
  );
  const row = found.rows[0];
  if (!row || row.status === "removed") {
    await audit(db, {
      source: "ui",
      actor: `user:${email}`,
      action: "auth.rejected",
      entityType: "users",
      entityId: email,
      detail: { reason: "not_invited" },
    });
    throw new AuthError(403, "forbidden", "That account has not been invited");
  }
  await db.query(
    `UPDATE users
     SET status = 'active',
         google_sub = COALESCE($2, google_sub),
         name = CASE WHEN $3::text IS NULL OR name = email THEN COALESCE($3, name) ELSE name END
     WHERE id = $1`,
    [row.id, identity.sub ?? null, identity.name ?? null],
  );
  return { userId: row.id };
}

export async function acceptPassword(db: Db, emailRaw: string, password: string): Promise<{ userId: string }> {
  const email = normalizeLoginEmail(emailRaw);
  if (!email || !password) throw new AuthError(401, "unauthorized", "Email or password did not match");
  if (await loginRestricted(db) && !domainAllowed(email, true)) {
    throw new AuthError(403, "forbidden", "That domain is outside the five Figcel domains");
  }
  const found = await db.query<{ id: string; password_hash: string | null; status: string }>(
    "SELECT id, password_hash, status FROM users WHERE email = $1",
    [email],
  );
  const row = found.rows[0];
  const ok = row && row.status !== "removed" && (await verifyPassword(password, row.password_hash));
  if (!row || !ok) throw new AuthError(401, "unauthorized", "Email or password did not match");
  return { userId: row.id };
}

export type MagicDelivery = (input: { email: string; url: string }) => Promise<void>;

let deliverMagic: MagicDelivery = async () => {
  // Email delivery is TODO: mailer. The token stays hashed and is not logged.
};

export function setMagicDelivery(next: MagicDelivery | null): void {
  deliverMagic = next ?? (async () => undefined);
}

export async function issueMagicLink(db: Db, request: Request, emailRaw: string): Promise<void> {
  const email = normalizeLoginEmail(emailRaw);
  if (!email) return;
  const found = await db.query<{ id: string; status: string }>("SELECT id, status FROM users WHERE email = $1", [email]);
  const row = found.rows[0];
  if (!row || row.status === "removed") return;
  if (await loginRestricted(db) && !domainAllowed(email, true)) return;
  const token = randomToken();
  await db.query(
    `INSERT INTO login_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')`,
    [row.id, hashToken(token)],
  );
  const url = new URL("/api/auth/magic/consume", request.url);
  url.searchParams.set("token", token);
  await deliverMagic({ email, url: url.toString() });
  await audit(db, {
    source: "ui",
    actor: `user:${email}`,
    action: "auth.magic_issued",
    entityType: "users",
    entityId: row.id,
    detail: { delivery: "TODO: mailer" },
  });
}

export async function consumeMagicLink(db: Db, token: string): Promise<{ userId: string }> {
  const hashed = hashToken(token);
  const found = await db.query<{ id: string; user_id: string }>(
    `UPDATE login_tokens
     SET used_at = now()
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING id, user_id`,
    [hashed],
  );
  const row = found.rows[0];
  if (!row) throw new AuthError(401, "unauthorized", "That sign-in link is invalid or expired");
  return { userId: row.user_id };
}

export async function bootstrapAdmin(db: Db = getPool()): Promise<void> {
  const email = normalizeLoginEmail(process.env.BOOTSTRAP_ADMIN_EMAIL ?? "");
  if (!email) return;
  const admins = await db.query("SELECT 1 FROM users WHERE role = 'admin' AND status <> 'removed' LIMIT 1");
  if ((admins.rowCount ?? 0) > 0) return;
  await db.query(
    `INSERT INTO users (email, name, role, status)
     VALUES ($1, $1, 'admin', 'invited')
     ON CONFLICT (email) DO UPDATE SET role = 'admin', status = CASE WHEN users.status = 'removed' THEN 'invited' ELSE users.status END`,
    [email],
  );
}

export async function finishSignIn(db: Db, userId: string, actorEmail: string): Promise<{ sessionId: string; csrf: string }> {
  const session = await openSession(db, userId);
  const email = await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  await audit(db, {
    source: "ui",
    actor: `user:${email.rows[0]?.email ?? actorEmail}`,
    action: "auth.sign_in",
    entityType: "users",
    entityId: userId,
    detail: {},
  });
  return session;
}
