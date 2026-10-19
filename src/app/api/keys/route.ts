import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { createApiKey, listApiKeys } from "@/lib/api/keys";
import type { ApiRole } from "@/lib/api/actions";
import { getPool } from "@/lib/db/pool";
import { audit } from "@/lib/send/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await listApiKeys(getPool()));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not list keys";
    return NextResponse.json({ error: { code: "internal", message } }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  const body = (await request.json()) as { name?: string; role?: ApiRole; scopes?: string[]; rateLimitPerMinute?: number };
  if (!body.name || (body.role !== "admin" && body.role !== "operator" && body.role !== "viewer")) {
    return NextResponse.json({ error: { code: "validation", message: "name and role are required" } }, { status: 400 });
  }
  try {
    const created = await createApiKey(getPool(), {
      name: body.name,
      role: body.role,
      scopes: body.scopes,
      rateLimitPerMinute: body.rateLimitPerMinute,
    });
    await audit(getPool(), {
      source: "ui",
      actor: gate.user.actor,
      action: "keys.create",
      entityType: "api_keys",
      entityId: created.record.id,
      detail: { name: created.record.name, role: created.record.role },
    });
    return NextResponse.json({ secret: created.secret, key: created.record }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not create the key";
    const status = error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 500;
    return NextResponse.json({ error: { code: status === 400 ? "validation" : "internal", message } }, { status: status || 500 });
  }
}
