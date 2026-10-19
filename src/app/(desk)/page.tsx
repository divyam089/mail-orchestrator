import { StatusBoard } from "@/components/status-board";
import { loadStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function Home() {
  const status = await loadStatus();
  return <StatusBoard status={status} />;
}
