import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { readSendMode, readSendingEnabled } from "@/lib/gates";
import { MockMailAdapter } from "@/lib/mail/adapter";
import { loadReviewDesk } from "@/lib/send/desk";
import { decideDraft, editDraft } from "@/lib/send/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await loadReviewDesk());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load Review";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  const body = (await request.json()) as {
    id?: string;
    action?: "edit" | "approve" | "reject";
    subject?: string;
    body?: string;
  };
  if (!body.id || !body.action) {
    return NextResponse.json({ error: "id and action are required" }, { status: 400 });
  }
  const pool = getPool();
  try {
    if (body.action === "edit") {
      if (!body.subject?.trim() || !body.body?.trim()) {
        return NextResponse.json({ error: "subject and body are required" }, { status: 400 });
      }
      const result = await editDraft(pool, {
        id: body.id,
        subject: body.subject,
        body: body.body,
        actor: gate.user.actor,
        source: "ui",
      });
      if (!result.ok) return NextResponse.json(result, { status: 409 });
      return NextResponse.json(result);
    }
    const result = await decideDraft(pool, {
      id: body.id,
      action: body.action,
      actor: gate.user.actor,
      source: "ui",
      adapter: new MockMailAdapter(),
      sendingEnabled: readSendingEnabled(),
      sendMode: readSendMode(),
    });
    if (!result.ok) return NextResponse.json(result, { status: 409 });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update the draft";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
