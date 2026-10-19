import { expect, it } from "vitest";
import { NextRequest } from "next/server";
import { signValue } from "@/lib/auth/cookie";
import { SESSION_COOKIE } from "@/lib/auth/http";
import { middleware, readSessionCookie } from "@/middleware";

it("sends a desk page without a session to sign-in and leaves the API key routes alone", async () => {
  const page = await middleware(new NextRequest("http://127.0.0.1:43123/dashboard"));
  expect(page.headers.get("location")).toContain("/sign-in");
  const health = await middleware(new NextRequest("http://127.0.0.1:43123/api/health"));
  expect(health.status).toBe(401);
  const body = (await health.json()) as { error: { code: string } };
  expect(body.error.code).toBe("unauthorized");
  const v1 = await middleware(new NextRequest("http://127.0.0.1:43123/api/v1/campaigns"));
  expect(v1.headers.get("location")).toBeNull();
  expect(v1.status).not.toBe(401);
});

it("rejects a forged session cookie and accepts one this process signed", async () => {
  const forged = new NextRequest("http://127.0.0.1:43123/mail", {
    headers: { cookie: `${SESSION_COOKIE}=not-a-session.forged` },
  });
  expect((await middleware(forged)).headers.get("location")).toContain("/sign-in");
  expect(await readSessionCookie("not-a-session.forged")).toBeNull();
  const signed = signValue("11111111-1111-4111-8111-111111111111");
  expect(await readSessionCookie(signed)).toBe("11111111-1111-4111-8111-111111111111");
  const ok = new NextRequest("http://127.0.0.1:43123/team", {
    headers: { cookie: `${SESSION_COOKIE}=${signed}` },
  });
  const passed = await middleware(ok);
  expect(passed.headers.get("location")).toBeNull();
  expect(passed.status).not.toBe(401);
});
