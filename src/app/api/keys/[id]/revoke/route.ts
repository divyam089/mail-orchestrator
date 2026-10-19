import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { revokeApiKey } from "@/lib/api/keys";
import { getPool } from "@/lib/db/pool";
import { audit } from "@/lib/send/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  const { id } = await context.params;
  try {
    const revoked = await revokeApiKey(getPool(), id);
    if (!revoked) return NextResponse.json({ error: { code: "not_found", message: "key not found" } }, { status: 404 });
    await audit(getPool(), {
      source: "ui",
      actor: gate.user.actor,
      action: "keys.revoke",
      entityType: "api_keys",
      entityId: id,
    });
    return NextResponse.json({ revoked: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not revoke the key";
    return NextResponse.json({ error: { code: "internal", message } }, { status: 500 });
  }
}
