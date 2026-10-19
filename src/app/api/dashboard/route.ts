import { NextResponse } from "next/server";
import { getPool } from "@/lib/db/pool";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  try {
    const data = await loadDashboard(getPool(), parseRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }));
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not load the dashboard";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
