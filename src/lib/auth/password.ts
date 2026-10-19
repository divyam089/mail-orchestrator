import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb);
const KEYLEN = 32;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("base64url");
  const key = (await scrypt(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt}$${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [kind, salt, encoded] = stored.split("$");
  if (kind !== "scrypt" || !salt || !encoded) return false;
  const actual = (await scrypt(password, salt, KEYLEN)) as Buffer;
  const expected = Buffer.from(encoded, "base64url");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
