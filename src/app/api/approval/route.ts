import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import type { ApprovalMode } from "@/lib/gates";
import { setApprovalMode } from "@/lib/send/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const gate = await guard(request, "admin");
  if ("response" in gate) return gate.response;
  const body = (await request.json()) as {
    scope?: "global" | "campaign";
    mode?: ApprovalMode;
    campaignId?: string;
  };
  if ((body.scope !== "global" && body.scope !== "campaign") || (body.mode !== "review" && body.mode !== "auto")) {
    return NextResponse.json({ error: "scope and mode are required" }, { status: 400 });
  }
  try {
    const result = await setApprovalMode(getPool(), {
      scope: body.scope,
      mode: body.mode,
      campaignId: body.campaignId,
      source: "ui",
      actor: gate.user.actor,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not change approval";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
