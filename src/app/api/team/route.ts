import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { isRole } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import { AuthError } from "@/lib/auth/errors";
import { changeRole, inviteUser, listUsers, loginRestricted, removeUser, setLoginRestricted } from "@/lib/auth/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  const db = getPool();
  return NextResponse.json({ users: await listUsers(db), restrictLoginDomains: await loginRestricted(db) });
}

export async function POST(request: Request) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    email?: string;
    role?: string;
    userId?: string;
    restrict?: boolean;
    password?: string;
  };
  const db = getPool();
  try {
    if (body.action === "invite") {
      if (!body.email || !body.role || !isRole(body.role)) {
        return NextResponse.json({ error: { code: "validation", message: "Email and role are required" } }, { status: 400 });
      }
      const user = await inviteUser(db, { email: body.email, role: body.role, actor: gate.user.actor, password: body.password });
      return NextResponse.json({ user }, { status: 201 });
    }
    if (body.action === "role") {
      if (!body.userId || !body.role || !isRole(body.role)) {
        return NextResponse.json({ error: { code: "validation", message: "User and role are required" } }, { status: 400 });
      }
      await changeRole(db, { userId: body.userId, role: body.role, actor: gate.user.actor });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "remove") {
      if (!body.userId) return NextResponse.json({ error: { code: "validation", message: "User is required" } }, { status: 400 });
      await removeUser(db, { userId: body.userId, actor: gate.user.actor });
      return NextResponse.json({ ok: true });
    }
    if (body.action === "domains") {
      await setLoginRestricted(db, body.restrict === true, gate.user.actor);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: { code: "validation", message: "Unknown action" } }, { status: 400 });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    }
    throw error;
  }
}
