export type Role = "admin" | "operator" | "viewer";

export const LOGIN_DOMAINS = [
  "usefigcel.com",
  "tryfigcel.com",
  "meetfigcel.com",
  "getfigcel.com",
  "hellofigcel.com",
] as const;

const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export function isRole(value: string): value is Role {
  return value === "admin" || value === "operator" || value === "viewer";
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

export function emailDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function domainAllowed(email: string, restricted: boolean): boolean {
  if (!restricted) return true;
  return (LOGIN_DOMAINS as readonly string[]).includes(emailDomain(email));
}

export function normalizeLoginEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

export function actorFor(email: string): string {
  return `user:${email}`;
}
