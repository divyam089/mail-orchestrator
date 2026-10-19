import { NextResponse } from "next/server";
import { OAUTH_COOKIE, readCookie, readSigned } from "@/lib/auth/cookie";
import { oidcProvider } from "@/lib/auth/google";
import { getPool } from "@/lib/db/pool";
import { acceptIdentity, finishSignIn } from "@/lib/auth/users";
import { clearedSessionCookies, sessionCookies } from "@/lib/auth/session";
import { AuthError } from "@/lib/auth/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function fail(request: Request, code: string) {
  const response = NextResponse.redirect(new URL(`/sign-in?error=${code}`, request.url));
  for (const cookie of clearedSessionCookies()) response.headers.append("set-cookie", cookie);
  return response;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const signed = readSigned(readCookie(request, OAUTH_COOKIE));
  const [savedState, nonce, exp] = signed?.split(".") ?? [];
  if (!code || !savedState || savedState !== state || !nonce || Date.now() > Number(exp)) return fail(request, "expired");
  try {
    const identity = await oidcProvider().exchangeCode({
      code,
      redirectUri: new URL("/api/auth/google/callback", request.url).toString(),
      nonce,
    });
    if (identity.nonce !== nonce) return fail(request, "expired");
    const db = getPool();
    const accepted = await acceptIdentity(db, identity);
    const session = await finishSignIn(db, accepted.userId, identity.email);
    const response = NextResponse.redirect(new URL("/", request.url));
    for (const cookie of sessionCookies(request, session.sessionId, session.csrf)) response.headers.append("set-cookie", cookie);
    response.headers.append("set-cookie", `${OAUTH_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`);
    return response;
  } catch (error) {
    if (error instanceof AuthError && error.message.includes("not been invited")) return fail(request, "not_invited");
    if (error instanceof AuthError && error.message.includes("domain")) return fail(request, "domain");
    return fail(request, "google");
  }
}
