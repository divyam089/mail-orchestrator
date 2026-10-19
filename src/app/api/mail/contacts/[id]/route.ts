import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { addNote, setTag } from "@/lib/mail/mailbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  const { id } = await context.params;
  const body = (await request.json()) as { kind?: string; body?: string; name?: string; remove?: boolean };
  const pool = getPool();
  try {
    if (body.kind === "note") {
      if (!body.body?.trim()) return NextResponse.json({ error: "note body is required" }, { status: 400 });
      await addNote(pool, { contactId: id, body: body.body, actor: gate.user.actor, source: "ui" });
    } else if (body.kind === "tag") {
      if (!body.name?.trim()) return NextResponse.json({ error: "tag name is required" }, { status: 400 });
      await setTag(pool, { contactId: id, name: body.name, remove: body.remove, actor: gate.user.actor, source: "ui" });
    } else {
      return NextResponse.json({ error: "kind must be note or tag" }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the contact";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
