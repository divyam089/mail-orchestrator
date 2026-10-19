import { DashboardLive } from "@/components/dashboard-live";
import { getPool } from "@/lib/db/pool";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  try {
    const data = await loadDashboard(getPool(), parseRange({ from: one("from"), to: one("to") }));
    return <DashboardLive initial={data} />;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dashboard is unavailable";
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="font-display text-3xl">Dashboard unavailable</h1>
        <p className="mt-3 text-sm text-rust">{message}</p>
      </main>
    );
  }
}
