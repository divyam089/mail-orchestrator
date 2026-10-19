import { NextResponse } from "next/server";
import { CSRF_COOKIE, localLoginEnabled, readCookie } from "@/lib/auth/cookie";
import { AuthError } from "@/lib/auth/errors";
import { getPool } from "@/lib/db/pool";
import { sessionCookies } from "@/lib/auth/session";
import { acceptPassword, finishSignIn } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!localLoginEnabled()) {
    return NextResponse.json({ error: { code: "not_found", message: "Password sign-in is off" } }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { email?: string; password?: string; csrf?: string };
  const csrf = request.headers.get("x-csrf-token") || body.csrf || "";
  if (!csrf || csrf !== readCookie(request, CSRF_COOKIE)) {
    return NextResponse.json({ error: { code: "forbidden", message: "Refresh the page and try again" } }, { status: 403 });
  }
  try {
    const db = getPool();
    const accepted = await acceptPassword(db, body.email ?? "", body.password ?? "");
    const session = await finishSignIn(db, accepted.userId, body.email ?? "");
    const response = NextResponse.json({ ok: true });
    for (const cookie of sessionCookies(request, session.sessionId, session.csrf)) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    throw error;
  }
}
