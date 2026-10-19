import { NextResponse } from "next/server";
import { loadImportDesk } from "@/lib/contacts/desk";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await loadImportDesk());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the hold list";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
