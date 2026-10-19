import { getPool } from "@/lib/db/pool";
import { CSV_VIEWS, snapshotCsv, type CsvView } from "@/lib/dashboard/csv";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const view = url.searchParams.get("view") ?? "";
  if (!CSV_VIEWS.includes(view as CsvView)) {
    return new Response("view must be one of the dashboard tables", { status: 400 });
  }
  try {
    const data = await loadDashboard(getPool(), parseRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") }));
    const body = snapshotCsv(view as CsvView, data);
    return new Response(body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="dashboard-${view}.csv"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not export";
    return new Response(message, { status: 500 });
  }
}
