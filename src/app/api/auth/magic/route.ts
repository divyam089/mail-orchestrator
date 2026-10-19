import { NextResponse } from "next/server";
import { CSRF_COOKIE, localLoginEnabled, readCookie } from "@/lib/auth/cookie";
import { getPool } from "@/lib/db/pool";
import { issueMagicLink } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!localLoginEnabled()) {
    return NextResponse.json({ error: { code: "not_found", message: "Email sign-in is off" } }, { status: 404 });
  }
  const body = (await request.json().catch(() => ({}))) as { email?: string; csrf?: string };
  const csrf = request.headers.get("x-csrf-token") || body.csrf || "";
  if (!csrf || csrf !== readCookie(request, CSRF_COOKIE)) {
    return NextResponse.json({ error: { code: "forbidden", message: "Refresh the page and try again" } }, { status: 403 });
  }
  await issueMagicLink(getPool(), request, body.email ?? "");
  return NextResponse.json({
    ok: true,
    message: "If this address has been invited, a sign-in link was issued. Email delivery is TODO: mailer.",
  });
}
