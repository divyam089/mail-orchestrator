import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import type { ApiRole } from "@/lib/api/actions";
import { scopesForRole } from "@/lib/api/actions";
import { ApiError } from "@/lib/api/errors";

export type ApiKeyRecord = {
  id: string;
  name: string;
  role: ApiRole;
  scopes: string[];
  rateLimitPerMinute: number;
  prefix: string;
};

export function hashApiKey(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export async function createApiKey(
  db: Db,
  input: { name: string; role: ApiRole; scopes?: string[]; rateLimitPerMinute?: number },
): Promise<{ secret: string; record: ApiKeyRecord }> {
  const name = input.name.trim();
  if (!name || name.length > 80) throw new ApiError(400, "validation", "name is required");
  if (input.role !== "admin" && input.role !== "operator" && input.role !== "viewer") {
    throw new ApiError(400, "validation", "role must be admin, operator, or viewer");
  }
  const allowed = new Set(scopesForRole(input.role));
  const scopes = [...new Set((input.scopes ?? []).map((scope) => scope.trim()).filter(Boolean))];
  for (const scope of scopes) {
    if (!allowed.has(scope)) throw new ApiError(400, "validation", `scope ${scope} is outside the ${input.role} role`);
  }
  const limit = input.rateLimitPerMinute ?? 60;
  if (!Number.isInteger(limit) || limit < 1 || limit > 600) {
    throw new ApiError(400, "validation", "rateLimitPerMinute must be from 1 to 600");
  }
  const secret = `fgk_${randomBytes(24).toString("hex")}`;
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO api_keys (name, key_hash, prefix, role, scopes, rate_limit_per_minute)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, hashApiKey(secret), secret.slice(0, 12), input.role, scopes, limit],
  );
  return {
    secret,
    record: { id: inserted.rows[0].id, name, role: input.role, scopes, rateLimitPerMinute: limit, prefix: secret.slice(0, 12) },
  };
}

export async function authenticateApiKey(db: Db, header: string | null): Promise<ApiKeyRecord> {
  const token = bearer(header);
  if (!token) throw new ApiError(401, "unauthorized", "Send Authorization: Bearer fgk_…");
  const found = await db.query<{
    id: string;
    name: string;
    role: ApiRole;
    scopes: string[];
    rate_limit_per_minute: number;
    prefix: string;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, role, scopes, rate_limit_per_minute, prefix, revoked_at
     FROM api_keys WHERE key_hash = $1`,
    [hashApiKey(token)],
  );
  const row = found.rows[0];
  if (!row || row.revoked_at) throw new ApiError(401, "unauthorized", "API key is missing or revoked");
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    scopes: row.scopes ?? [],
    rateLimitPerMinute: row.rate_limit_per_minute,
    prefix: row.prefix,
  };
}

export async function listApiKeys(db: Db): Promise<unknown[]> {
  const rows = await db.query(
    `SELECT id, name, prefix, role, scopes, rate_limit_per_minute, created_at, revoked_at
     FROM api_keys ORDER BY created_at DESC`,
  );
  return rows.rows;
}

export async function revokeApiKey(db: Db, id: string): Promise<boolean> {
  const updated = await db.query(
    `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
    [id],
  );
  return (updated.rowCount ?? 0) > 0;
}

function bearer(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
