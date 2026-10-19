import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { clearedSessionCookies, revokeSession } from "@/lib/auth/session";
import { audit } from "@/lib/send/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  await revokeSession(getPool(), gate.user.sessionId);
  await audit(getPool(), {
    source: "ui",
    actor: gate.user.actor,
    action: "auth.sign_out",
    entityType: "sessions",
    entityId: gate.user.sessionId,
    detail: {},
  });
  const response = NextResponse.json({ ok: true });
  for (const cookie of clearedSessionCookies()) response.headers.append("set-cookie", cookie);
  return response;
}
