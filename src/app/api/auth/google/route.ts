import { NextResponse } from "next/server";
import { OAUTH_COOKIE, cookieFlags, randomToken, serializeCookie, signValue } from "@/lib/auth/cookie";
import { oidcProvider } from "@/lib/auth/google";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const provider = oidcProvider();
  if (!provider.configured()) {
    return NextResponse.redirect(new URL("/sign-in?error=google_not_configured", request.url));
  }
  const state = randomToken();
  const nonce = randomToken();
  const exp = Date.now() + 10 * 60 * 1000;
  const response = NextResponse.redirect(provider.authorizationUrl({
    state,
    nonce,
    redirectUri: new URL("/api/auth/google/callback", request.url).toString(),
  }));
  response.headers.append(
    "set-cookie",
    serializeCookie(OAUTH_COOKIE, signValue(`${state}.${nonce}.${exp}`), cookieFlags(request, true, 600)),
  );
  return response;
}
