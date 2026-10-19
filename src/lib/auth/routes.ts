import type { Role } from "@/lib/auth/roles";

export type RouteAuth = "public" | "session" | "api-key";

export type RouteGuard = {
  file: string;
  url: string;
  auth: RouteAuth;
  role?: Role;
  methods: string[];
};

/**
 * Every page and route handler. The walker test fails when a file is missing
 * here, or when a session route answers without this role.
 */
export const ROUTE_GUARDS: RouteGuard[] = [
  { file: "src/app/sign-in/page.tsx", url: "/sign-in", auth: "public", methods: ["GET"] },
  { file: "src/app/api/auth/google/route.ts", url: "/api/auth/google", auth: "public", methods: ["GET"] },
  { file: "src/app/api/auth/google/callback/route.ts", url: "/api/auth/google/callback", auth: "public", methods: ["GET"] },
  { file: "src/app/api/auth/password/route.ts", url: "/api/auth/password", auth: "public", methods: ["POST"] },
  { file: "src/app/api/auth/magic/route.ts", url: "/api/auth/magic", auth: "public", methods: ["POST"] },
  { file: "src/app/api/auth/magic/consume/route.ts", url: "/api/auth/magic/consume", auth: "public", methods: ["GET"] },
  { file: "src/app/api/auth/sign-out/route.ts", url: "/api/auth/sign-out", auth: "session", role: "viewer", methods: ["POST"] },
  { file: "src/app/api/auth/sign-out-all/route.ts", url: "/api/auth/sign-out-all", auth: "session", role: "viewer", methods: ["POST"] },
  { file: "src/app/(desk)/page.tsx", url: "/", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/dashboard/page.tsx", url: "/dashboard", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/mail/page.tsx", url: "/mail", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/review/page.tsx", url: "/review", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/import/page.tsx", url: "/import", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/api/docs/page.tsx", url: "/api/docs", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/(desk)/keys/page.tsx", url: "/keys", auth: "session", role: "admin", methods: ["GET"] },
  { file: "src/app/(desk)/team/page.tsx", url: "/team", auth: "session", role: "admin", methods: ["GET"] },
  { file: "src/app/api/health/route.ts", url: "/api/health", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/api/dashboard/route.ts", url: "/api/dashboard", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/api/dashboard/export/route.ts", url: "/api/dashboard/export", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/api/dashboard/stream/route.ts", url: "/api/dashboard/stream", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/api/holds/route.ts", url: "/api/holds", auth: "session", role: "viewer", methods: ["GET"] },
  { file: "src/app/api/review/route.ts", url: "/api/review", auth: "session", role: "viewer", methods: ["GET", "POST"] },
  { file: "src/app/api/imports/route.ts", url: "/api/imports", auth: "session", role: "operator", methods: ["POST"] },
  { file: "src/app/api/holds/[id]/route.ts", url: "/api/holds/{id}", auth: "session", role: "operator", methods: ["POST"] },
  { file: "src/app/api/review/bulk/route.ts", url: "/api/review/bulk", auth: "session", role: "operator", methods: ["POST"] },
  { file: "src/app/api/mail/compose/route.ts", url: "/api/mail/compose", auth: "session", role: "operator", methods: ["POST"] },
  { file: "src/app/api/mail/templates/route.ts", url: "/api/mail/templates", auth: "session", role: "viewer", methods: ["GET", "POST"] },
  { file: "src/app/api/mail/threads/[id]/route.ts", url: "/api/mail/threads/{id}", auth: "session", role: "viewer", methods: ["GET", "POST"] },
  { file: "src/app/api/mail/contacts/[id]/route.ts", url: "/api/mail/contacts/{id}", auth: "session", role: "operator", methods: ["POST"] },
  { file: "src/app/api/approval/route.ts", url: "/api/approval", auth: "session", role: "admin", methods: ["POST"] },
  { file: "src/app/api/keys/route.ts", url: "/api/keys", auth: "session", role: "admin", methods: ["GET", "POST"] },
  { file: "src/app/api/keys/[id]/revoke/route.ts", url: "/api/keys/{id}/revoke", auth: "session", role: "admin", methods: ["POST"] },
  { file: "src/app/api/team/route.ts", url: "/api/team", auth: "session", role: "admin", methods: ["GET", "POST"] },
  { file: "src/app/api/v1/[[...path]]/route.ts", url: "/api/v1", auth: "api-key", methods: ["GET", "POST", "PATCH", "DELETE"] },
];

const METHOD_ROLE: Record<string, Record<string, Role>> = {
  "src/app/api/review/route.ts": { GET: "viewer", POST: "operator" },
  "src/app/api/mail/threads/[id]/route.ts": { GET: "viewer", POST: "operator" },
  "src/app/api/mail/templates/route.ts": { GET: "viewer", POST: "operator" },
};

export function roleFor(guard: RouteGuard, method: string): Role | null {
  if (guard.auth !== "session") return null;
  return METHOD_ROLE[guard.file]?.[method] ?? guard.role ?? "admin";
}

export function isPublicPath(pathname: string): boolean {
  return ROUTE_GUARDS.some((guard) => guard.auth === "public" && guard.url === pathname);
}

export function isApiKeyPath(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}
