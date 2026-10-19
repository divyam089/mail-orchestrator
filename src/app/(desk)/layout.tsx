import { GateBanner } from "@/components/status-board";
import { requirePage } from "@/lib/auth/guard";
import { loadStatus } from "@/lib/status";

export const dynamic = "force-dynamic";

export default async function DeskLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePage("viewer");
  const status = await loadStatus();
  return (
    <>
      <GateBanner status={status} user={{ email: user.email, role: user.role }} />
      {children}
    </>
  );
}
