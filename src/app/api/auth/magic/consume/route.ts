import { NextResponse } from "next/server";
import { localLoginEnabled } from "@/lib/auth/cookie";
import { AuthError } from "@/lib/auth/errors";
import { getPool } from "@/lib/db/pool";
import { sessionCookies } from "@/lib/auth/session";
import { consumeMagicLink, finishSignIn } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!localLoginEnabled()) return NextResponse.redirect(new URL("/sign-in?error=local_off", request.url));
  const token = new URL(request.url).searchParams.get("token") ?? "";
  try {
    const db = getPool();
    const accepted = await consumeMagicLink(db, token);
    const session = await finishSignIn(db, accepted.userId, "");
    const response = NextResponse.redirect(new URL("/", request.url));
    for (const cookie of sessionCookies(request, session.sessionId, session.csrf)) response.headers.append("set-cookie", cookie);
    return response;
  } catch (error) {
    const code = error instanceof AuthError ? "expired" : "expired";
    return NextResponse.redirect(new URL(`/sign-in?error=${code}`, request.url));
  }
}
