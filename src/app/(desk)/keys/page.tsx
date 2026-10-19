import { KeyDesk } from "@/components/key-desk";
import { listApiKeys } from "@/lib/api/keys";
import { requirePage } from "@/lib/auth/guard";
import { getPool } from "@/lib/db/pool";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  await requirePage("admin");
  let keys: unknown[] = [];
  let error: string | null = null;
  try {
    keys = await listApiKeys(getPool());
  } catch (caught) {
    error = caught instanceof Error ? caught.message : "Keys are unavailable";
  }
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Admin · API keys</p>
      <h1 className="font-display mt-2 text-4xl">Keys</h1>
      <p className="mt-4 text-sm leading-relaxed text-muted">
        This desk creates and revokes keys for the API. The secret is shown once and stored as a SHA-256 hash. A key
        has the admin, operator, or viewer role. The API rejects a weaker key. Only an admin who is signed in can open
        this page. The kill switch is not a key setting.
      </p>
      {error ? <p className="mt-4 text-sm text-rust">{error}</p> : <KeyDesk keys={keys} />}
    </main>
  );
}
