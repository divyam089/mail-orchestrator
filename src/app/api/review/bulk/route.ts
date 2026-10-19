import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { readSendMode, readSendingEnabled } from "@/lib/gates";
import { MockMailAdapter } from "@/lib/mail/adapter";
import { bulkDecide } from "@/lib/send/review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json()) as { ids?: string[]; action?: "approve" | "reject" };
  if (!body.action || !Array.isArray(body.ids) || body.ids.length === 0) {
    return NextResponse.json({ error: "ids and action are required" }, { status: 400 });
  }
  try {
    const results = await bulkDecide(getPool(), {
      ids: body.ids,
      action: body.action,
      actor: "operator",
      source: "ui",
      adapter: new MockMailAdapter(),
      sendingEnabled: readSendingEnabled(),
      sendMode: readSendMode(),
    });
    return NextResponse.json({ results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not update drafts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
