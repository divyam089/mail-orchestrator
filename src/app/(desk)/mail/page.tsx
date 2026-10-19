import { MailWorkspace } from "@/components/mail-workspace";
import { requirePage } from "@/lib/auth/guard";
import { roleAtLeast } from "@/lib/auth/roles";
import { getPool } from "@/lib/db/pool";
import type { MailView } from "@/lib/mail/mailbox";
import { listTemplates, listThreads, loadThread } from "@/lib/mail/mailbox";
import { loadSendSettings } from "@/lib/send/settings";

export const dynamic = "force-dynamic";

const VIEWS = new Set<MailView>(["inbox", "starred", "snoozed", "archive", "all"]);

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePage("viewer");
  const params = await searchParams;
  const viewParam = one(params.view);
  const view = VIEWS.has(viewParam as MailView) ? (viewParam as MailView) : "inbox";
  const filters = {
    q: one(params.q),
    inboxId: one(params.inbox),
    view,
    label: one(params.label),
    campaignId: one(params.campaign),
  };
  const pool = getPool();
  try {
    const [threads, inboxes, campaigns, labelRows, templates, settings] = await Promise.all([
      listThreads(pool, {
        q: filters.q || null,
        inboxId: filters.inboxId || null,
        view,
        label: filters.label || null,
        campaignId: filters.campaignId || null,
      }),
      pool.query<{ id: string; email: string }>("SELECT id, email FROM inboxes ORDER BY email"),
      pool.query<{ id: string; name: string }>("SELECT id, name FROM campaigns ORDER BY name"),
      pool.query<{ name: string }>("SELECT DISTINCT name FROM labels ORDER BY name"),
      listTemplates(pool),
      loadSendSettings(pool),
    ]);
    const requested = one(params.thread);
    const selected = threads.find((thread) => thread.id === requested)?.id ?? threads[0]?.id ?? null;
    const detail = selected ? await loadThread(pool, selected) : null;
    return (
      <MailWorkspace
        threads={threads}
        detail={detail}
        inboxes={inboxes.rows}
        campaigns={campaigns.rows}
        labels={labelRows.rows.map((row) => row.name)}
        templates={templates}
        filters={filters}
        approvalMode={settings.approvalMode}
        canWrite={roleAtLeast(user.role, "operator")}
      />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mailbox is unavailable";
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="font-display text-3xl">Mailbox unavailable</h1>
        <p className="mt-3 text-sm text-rust">{message}</p>
      </main>
    );
  }
}
