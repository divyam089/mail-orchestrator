import { ImportDesk } from "@/components/import-desk";
import { requirePage } from "@/lib/auth/guard";
import { roleAtLeast } from "@/lib/auth/roles";
import { loadImportDesk, type ImportDesk as DeskData } from "@/lib/contacts/desk";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await requirePage("viewer");
  let desk: DeskData | null = null;
  let error: string | null = null;
  try {
    desk = await loadImportDesk();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Database unreachable";
  }
  return <ImportDesk initial={desk} loadError={error} canWrite={roleAtLeast(user.role, "operator")} />;
}
