export const SESSION_COOKIE = "figcel_session";
export const CSRF_COOKIE = "figcel_csrf";
export const OAUTH_COOKIE = "figcel_oauth";
export const SESSION_HOURS = 12;

const DEV_SESSION_SECRET = "dev-only-not-a-credential";

export function sessionSecret(): string {
  return process.env.SESSION_SECRET?.trim() || DEV_SESSION_SECRET;
}

export function localLoginEnabled(): boolean {
  return process.env.LOCAL_LOGIN_ENABLED === "true";
}

export type CookieOptions = {
  httpOnly: boolean;
  sameSite: "lax";
  path: string;
  secure: boolean;
  maxAge: number;
};

export function cookieFlags(request: Request, httpOnly: boolean, maxAge = SESSION_HOURS * 3600): CookieOptions {
  const proto = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  return { httpOnly, sameSite: "lax", path: "/", secure: proto === "https", maxAge };
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${options.maxAge}`,
    "SameSite=Lax",
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}
