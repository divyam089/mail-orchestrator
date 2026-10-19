import { TeamDesk } from "@/components/team-desk";
import { localLoginEnabled } from "@/lib/auth/cookie";
import { requirePage } from "@/lib/auth/guard";
import { listUsers, loginRestricted } from "@/lib/auth/users";
import { getPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  await requirePage("admin");
  const db = getPool();
  const users = await listUsers(db);
  const restricted = await loginRestricted(db);
  return <TeamDesk users={users} restricted={restricted} localLogin={localLoginEnabled()} />;
}
