import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { decideHold, type HoldDecision } from "@/lib/contacts/holds";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const gate = await guard(request, "operator");
  if ("response" in gate) return gate.response;
  const { id } = await context.params;
  let body: { action?: string };
  try {
    body = (await request.json()) as { action?: string };
  } catch {
    return NextResponse.json({ error: "Send JSON with action approve or reject." }, { status: 400 });
  }
  if (body.action !== "approve" && body.action !== "reject") {
    return NextResponse.json({ error: "action must be approve or reject." }, { status: 400 });
  }
  const action: HoldDecision = body.action;
  try {
    const result = await decideHold(getPool(), { holdId: id, action, actor: gate.user.actor, source: "ui" });
    if (!result.ok) {
      return NextResponse.json({ error: result.reason === "not_found" ? "Hold not found." : "That hold is already decided." }, { status: 409 });
    }
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not decide the hold";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
