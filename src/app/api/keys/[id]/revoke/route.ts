import { NextResponse } from "next/server";
import { revokeApiKey } from "@/lib/api/keys";
import { getPool } from "@/lib/db/pool";
import { audit } from "@/lib/send/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const revoked = await revokeApiKey(getPool(), id);
    if (!revoked) return NextResponse.json({ error: { code: "not_found", message: "key not found" } }, { status: 404 });
    await audit(getPool(), {
      source: "ui",
      actor: "ui:admin",
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
