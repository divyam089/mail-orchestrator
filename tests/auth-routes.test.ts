import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { handleApiV1, toApiResult, type ApiCall } from "@/lib/api/handle";
import { createApiKey } from "@/lib/api/keys";
import { requirePage } from "@/lib/auth/guard";
import { ROUTE_GUARDS, roleFor, type RouteGuard } from "@/lib/auth/routes";
import { setSessionLoader, type SessionUser } from "@/lib/auth/session";
import type { Role } from "@/lib/auth/roles";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [{ name: "figcel_session", value: "present" }],
  }),
}));

const root = join(process.cwd(), "src/app");

type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

const loaders: Record<string, () => Promise<unknown>> = {
  "src/app/api/auth/google/route.ts": () => import("@/app/api/auth/google/route"),
  "src/app/api/auth/google/callback/route.ts": () => import("@/app/api/auth/google/callback/route"),
  "src/app/api/auth/password/route.ts": () => import("@/app/api/auth/password/route"),
  "src/app/api/auth/magic/route.ts": () => import("@/app/api/auth/magic/route"),
  "src/app/api/auth/magic/consume/route.ts": () => import("@/app/api/auth/magic/consume/route"),
  "src/app/api/auth/sign-out/route.ts": () => import("@/app/api/auth/sign-out/route"),
  "src/app/api/auth/sign-out-all/route.ts": () => import("@/app/api/auth/sign-out-all/route"),
  "src/app/api/health/route.ts": () => import("@/app/api/health/route"),
  "src/app/api/dashboard/route.ts": () => import("@/app/api/dashboard/route"),
  "src/app/api/dashboard/export/route.ts": () => import("@/app/api/dashboard/export/route"),
  "src/app/api/dashboard/stream/route.ts": () => import("@/app/api/dashboard/stream/route"),
  "src/app/api/holds/route.ts": () => import("@/app/api/holds/route"),
  "src/app/api/review/route.ts": () => import("@/app/api/review/route"),
  "src/app/api/imports/route.ts": () => import("@/app/api/imports/route"),
  "src/app/api/holds/[id]/route.ts": () => import("@/app/api/holds/[id]/route"),
  "src/app/api/review/bulk/route.ts": () => import("@/app/api/review/bulk/route"),
  "src/app/api/mail/compose/route.ts": () => import("@/app/api/mail/compose/route"),
  "src/app/api/mail/templates/route.ts": () => import("@/app/api/mail/templates/route"),
  "src/app/api/mail/threads/[id]/route.ts": () => import("@/app/api/mail/threads/[id]/route"),
  "src/app/api/mail/contacts/[id]/route.ts": () => import("@/app/api/mail/contacts/[id]/route"),
  "src/app/api/approval/route.ts": () => import("@/app/api/approval/route"),
  "src/app/api/keys/route.ts": () => import("@/app/api/keys/route"),
  "src/app/api/keys/[id]/revoke/route.ts": () => import("@/app/api/keys/[id]/revoke/route"),
  "src/app/api/team/route.ts": () => import("@/app/api/team/route"),
};

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (name === "page.tsx" || name === "route.ts") found.push(full.slice(process.cwd().length + 1));
  }
  return found;
}

function user(role: Role): SessionUser {
  return {
    id: "00000000-0000-4000-8000-0000000000aa",
    email: `${role}@example.test`,
    name: role,
    role,
    csrf: "csrf-token",
    sessionId: "00000000-0000-4000-8000-0000000000bb",
    actor: `user:${role}@example.test`,
  };
}

function requestFor(method: string, url: string): Request {
  return new Request(`http://127.0.0.1${url}`, {
    method,
    headers: {
      cookie: "figcel_csrf=csrf-token",
      "x-csrf-token": "csrf-token",
      "content-type": "application/json",
    },
    body: method === "GET" ? undefined : "{}",
  });
}

const context = { params: Promise.resolve({ id: "00000000-0000-4000-8000-0000000000cc" }) };

afterEach(() => {
  setSessionLoader(null);
});

it("registers every page and route, and denies a missing or weak session", async () => {
  const files = walk(root).sort();
  const registered = ROUTE_GUARDS.map((guard) => guard.file).sort();
  expect(registered).toEqual(files);

  const layout = readFileSync(join(process.cwd(), "src/app/(desk)/layout.tsx"), "utf8");
  expect(layout).toContain('requirePage("viewer")');
  for (const guard of ROUTE_GUARDS.filter((item) => item.auth === "session" && item.role === "admin" && item.file.endsWith("page.tsx"))) {
    expect(readFileSync(join(process.cwd(), guard.file), "utf8")).toContain('requirePage("admin")');
  }

  for (const guard of ROUTE_GUARDS.filter((item) => item.file.endsWith("route.ts") && item.auth !== "api-key")) {
    const mod = (await loaders[guard.file]()) as Record<string, Handler | string | undefined>;
    expect(mod, guard.file).toBeTruthy();
    const exported = ["GET", "POST", "PATCH", "DELETE"].filter((method) => typeof mod[method] === "function");
    expect(exported.sort(), guard.file).toEqual([...guard.methods].sort());
    for (const method of guard.methods) {
      const handler = mod[method] as Handler;
      if (guard.auth === "public") {
        const response = await handler(requestFor(method, guard.url.replaceAll("{id}", "x")), context);
        expect(response.status, `${method} ${guard.url}`).not.toBe(401);
        continue;
      }
      setSessionLoader(async () => null);
      const missing = await handler(requestFor(method, guard.url.replaceAll("{id}", "x")), context);
      expect(missing.status, `${method} ${guard.url} unsigned`).toBe(401);
      await expectLowRole(guard, method, handler);
    }
  }

  setSessionLoader(async () => null);
  await expect(requirePage("viewer")).rejects.toThrow("REDIRECT:/sign-in");
  setSessionLoader(async () => user("viewer"));
  await expect(requirePage("admin")).rejects.toThrow("REDIRECT:/");
  expect((await requirePage("viewer")).role).toBe("viewer");
  setSessionLoader(async () => user("operator"));
  await expect(requirePage("admin")).rejects.toThrow("REDIRECT:/");
  setSessionLoader(async () => user("admin"));
  expect((await requirePage("admin")).role).toBe("admin");
});

async function expectLowRole(guard: RouteGuard, method: string, handler: Handler) {
  const min = roleFor(guard, method);
  if (min === "operator" || min === "admin") {
    setSessionLoader(async () => user("viewer"));
    const response = await handler(requestFor(method, guard.url.replaceAll("{id}", "x")), context);
    expect(response.status, `viewer ${method} ${guard.url}`).toBe(403);
  }
  if (min === "admin") {
    setSessionLoader(async () => user("operator"));
    const response = await handler(requestFor(method, guard.url.replaceAll("{id}", "x")), context);
    expect(response.status, `operator ${method} ${guard.url}`).toBe(403);
  }
}

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");
const pool = new Pool({ connectionString });

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

it("keeps /api/v1 on API keys, including a role that is too low", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const missing = await call(client, undefined, "GET", "/campaigns");
    expect(missing.status).toBe(401);
    const viewer = await createApiKey(client, { name: "route-walker", role: "viewer" });
    const keys = await call(client, viewer.secret, "POST", "/keys", { name: "nope", role: "viewer" });
    expect(keys.status).toBe(403);
    const approval = await call(client, viewer.secret, "POST", "/approval", { scope: "global", mode: "review" });
    expect(approval.status).toBe(403);
    const operator = await createApiKey(client, { name: "route-walker-ops", role: "operator" });
    const pause = await call(client, operator.secret, "POST", "/inboxes/00000000-0000-4000-8000-0000000000dd/pause", {});
    expect(pause.status).toBe(403);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

async function call(client: PoolClient, secret: string | undefined, method: string, path: string, body?: unknown) {
  const headers = {
    get: (name: string) => (name.toLowerCase() === "authorization" && secret ? `Bearer ${secret}` : null),
  };
  const input: ApiCall = { method, path, headers, body: body ?? {}, search: new URLSearchParams() };
  try {
    return await handleApiV1(client, input);
  } catch (error) {
    return toApiResult(error);
  }
}
