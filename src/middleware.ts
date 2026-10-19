import { NextResponse, type NextRequest } from "next/server";
import { CSRF_COOKIE, SESSION_COOKIE, cookieFlags, serializeCookie, sessionSecret } from "@/lib/auth/http";
import { isApiKeyPath, isPublicPath } from "@/lib/auth/routes";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function mac(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return base64url(new Uint8Array(signed));
}

export async function readSessionCookie(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = token.slice(0, dot);
  const given = token.slice(dot + 1);
  const expected = await mac(value);
  if (expected.length !== given.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0 ? value : null;
}

function randomCsrf(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/_next") || pathname === "/favicon.ico") return NextResponse.next();
  if (isApiKeyPath(pathname)) return NextResponse.next();
  if (isPublicPath(pathname)) {
    const response = NextResponse.next();
    if (pathname === "/sign-in" && !request.cookies.get(CSRF_COOKIE)?.value) {
      const flags = cookieFlags(request, false);
      response.headers.append("set-cookie", serializeCookie(CSRF_COOKIE, randomCsrf(), flags));
    }
    return response;
  }
  const sessionId = await readSessionCookie(request.cookies.get(SESSION_COOKIE)?.value);
  if (sessionId) return NextResponse.next();
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: { code: "unauthorized", message: "Sign in required" } }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/sign-in";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
