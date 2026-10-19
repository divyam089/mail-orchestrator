import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { loadImportDesk } from "@/lib/contacts/desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  try {
    return NextResponse.json(await loadImportDesk());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the hold list";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
