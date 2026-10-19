import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
  const url = new URL(request.url);
  try {
    const data = await loadDashboard(getPool(), parseRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }));
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the dashboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
