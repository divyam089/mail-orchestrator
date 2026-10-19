import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { sessionSecret } from "@/lib/auth/http";

export {
  CSRF_COOKIE,
  OAUTH_COOKIE,
  SESSION_COOKIE,
  SESSION_HOURS,
  clearCookie,
  cookieFlags,
  localLoginEnabled,
  readCookie,
  serializeCookie,
  sessionSecret,
} from "@/lib/auth/http";

export function signValue(value: string): string {
  const mac = createHmac("sha256", sessionSecret()).update(value).digest("base64url");
  return `${value}.${mac}`;
}

export function readSigned(token: string | undefined | null): string | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const value = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = createHmac("sha256", sessionSecret()).update(value).digest("base64url");
  const left = Buffer.from(mac);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return value;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
