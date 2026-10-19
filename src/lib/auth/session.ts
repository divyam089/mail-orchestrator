import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { getPool } from "@/lib/db/pool";
import { actorFor, type Role, isRole } from "@/lib/auth/roles";
import { CSRF_COOKIE, OAUTH_COOKIE, SESSION_COOKIE, SESSION_HOURS, cookieFlags, randomToken, readCookie, readSigned, serializeCookie, signValue } from "@/lib/auth/cookie";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  csrf: string;
  sessionId: string;
  actor: string;
};

type Loader = (request: Request) => Promise<SessionUser | null>;

async function loadSessionFromDb(request: Request): Promise<SessionUser | null> {
  const sessionId = readSigned(readCookie(request, SESSION_COOKIE));
  if (!sessionId) return null;
  return loadSessionById(getPool(), sessionId);
}

let loader: Loader = loadSessionFromDb;

export function setSessionLoader(next: Loader | null): void {
  loader = next ?? loadSessionFromDb;
}

export async function currentUser(request: Request): Promise<SessionUser | null> {
  return loader(request);
}

export async function loadSessionById(db: Db, sessionId: string): Promise<SessionUser | null> {
  const result = await db.query<{
    session_id: string;
    csrf_token: string;
    id: string;
    email: string;
    name: string;
    role: string;
  }>(
    `SELECT s.id AS session_id, s.csrf_token, u.id, u.email, u.name, u.role
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND u.status = 'active'`,
    [sessionId],
  );
  const row = result.rows[0];
  if (!row || !isRole(row.role)) return null;
  await db.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    csrf: row.csrf_token,
    sessionId: row.session_id,
    actor: actorFor(row.email),
  };
}

export async function openSession(db: Db, userId: string): Promise<{ sessionId: string; csrf: string }> {
  const csrf = randomToken(32);
  const created = await db.query<{ id: string }>(
    `INSERT INTO sessions (user_id, csrf_token, expires_at)
     VALUES ($1, $2, now() + interval '12 hours')
     RETURNING id`,
    [userId, csrf],
  );
  await db.query("UPDATE users SET status = 'active', last_sign_in_at = now() WHERE id = $1", [userId]);
  return { sessionId: created.rows[0].id, csrf };
}

export function sessionCookies(request: Request, sessionId: string, csrf: string): string[] {
  const flags = cookieFlags(request, true);
  const readable = cookieFlags(request, false);
  return [
    serializeCookie(SESSION_COOKIE, signValue(sessionId), flags),
    serializeCookie(CSRF_COOKIE, csrf, readable),
  ];
}

export function clearedSessionCookies(): string[] {
  return [
    `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
    `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`,
    `${OAUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`,
  ];
}

export async function revokeSession(db: Db, sessionId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

export async function revokeAllSessions(db: Db, userId: string): Promise<void> {
  await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export function csrfMatches(request: Request, csrf: string): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const header = request.headers.get("x-csrf-token") ?? "";
  const form = readCookie(request, CSRF_COOKIE) ?? "";
  return header.length > 0 && header === csrf && form === csrf;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function sessionLifetimeLabel(): string {
  return `${SESSION_HOURS} hours`;
}
