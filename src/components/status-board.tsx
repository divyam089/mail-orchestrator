import Link from "next/link";
import type { SystemStatus } from "@/lib/status";

function Chip({ label, value, tone }: { label: string; value: string; tone: "bad" | "ok" | "warn" }) {
  const toneClass =
    tone === "ok" ? "text-moss border-moss/30" : tone === "warn" ? "text-amber border-amber/30" : "text-rust border-rust/30";
  return (
    <div className={`min-w-0 border-l-2 px-3 py-1 ${toneClass}`}>
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="truncate text-sm font-medium">{value}</div>
    </div>
  );
}

function groupInboxes(status: SystemStatus) {
  const groups = new Map<string, SystemStatus["inboxes"]>();
  for (const inbox of status.inboxes) {
    const list = groups.get(inbox.domain) ?? [];
    list.push(inbox);
    groups.set(inbox.domain, list);
  }
  return [...groups.entries()];
}

export function GateBanner({ status }: { status: SystemStatus }) {
  const approval =
    status.approvalMode === "auto" ? "Auto-send ON" : status.approvalMode === "review" ? "Review queue · OFF" : "Unknown";
  return (
    <div className="border-b border-line bg-card" role="status">
      <div className="mx-auto flex max-w-[96rem] flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div>
          <div className="font-display text-lg leading-none">Figcel Outreach</div>
          <div className="mt-1 flex gap-3 text-xs">
            <Link className="text-muted underline decoration-line underline-offset-2" href="/">
              Status
            </Link>
            <Link className="text-muted underline decoration-line underline-offset-2" href="/import">
              Import
            </Link>
            <Link className="text-muted underline decoration-line underline-offset-2" href="/review">
              Review
            </Link>
            <Link className="text-muted underline decoration-line underline-offset-2" href="/mail">
              Mail
            </Link>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:flex sm:gap-6">
          <Chip label="Approval" value={approval} tone={status.approvalMode === "auto" ? "warn" : "bad"} />
          <Chip
            label="Kill switch"
            value={status.sendingEnabled ? "SENDING_ENABLED true" : "SENDING_ENABLED false"}
            tone={status.sendingEnabled ? "warn" : "bad"}
          />
          <Chip label="Postgres" value={status.postgres} tone={status.postgres === "up" ? "ok" : "bad"} />
          <Chip label="Redis" value={status.redis} tone={status.redis === "up" ? "ok" : "bad"} />
        </div>
      </div>
    </div>
  );
}

export function StatusBoard({ status }: { status: SystemStatus }) {
  const groups = groupInboxes(status);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Step 5 of 8 · Mailbox</p>
      <h1 className="font-display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">
        Sending is off. Approval stays in the review queue.
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        <Link className="text-ink underline decoration-line underline-offset-2" href="/import">
          Import
        </Link>{" "}
        takes a CSV or a paste, maps fields, keeps one contact per normalized address, and writes a dedupe report.
        Syntax, MX, role, disposable, and suppression run here. The verification provider is still{" "}
        {status.verificationProvider ?? "TODO: verification provider"}.{" "}
        {status.treatMxPassAsValid
          ? "The owner policy is on, so an MX pass is stored as valid while that provider is still TODO."
          : "An MX pass stays unknown. The owner policy that would treat it as valid is off."}{" "}
        Risky and unknown addresses wait on the hold list.{" "}
        <Link className="text-ink underline decoration-line underline-offset-2" href="/mail">
          Mail
        </Link>{" "}
        is the unified inbox: threads, search, and a reply that stays in Review while approval is off.
      </p>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-muted">
        This server does not call Gmail. A connect check and a sync run on a machine that has the service-account
        JSON, with <span className="font-mono text-ink">npm run inbox:check</span> and{" "}
        <span className="font-mono text-ink">npm run inbox:sync</span>. The repeating job is{" "}
        <span className="font-mono text-ink">npm run inbox:schedule</span>. This process does not start it.
      </p>

      {status.error ? (
        <p className="mt-6 border border-rust/40 bg-card px-4 py-3 text-sm text-rust">{status.error}</p>
      ) : null}

      <section className="mt-8 grid gap-4 lg:grid-cols-3">
        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">What blocks a send</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {status.blockers.map((blocker) => (
              <li key={blocker} className="border-l-2 border-rust pl-3">
                {blocker}
              </li>
            ))}
            {status.blockers.length === 0 ? <li>No hard blockers.</li> : null}
          </ul>
          <dl className="mt-4 space-y-2 text-sm text-muted">
            <div className="flex justify-between gap-4">
              <dt>Legal name</dt>
              <dd className="text-right text-ink">{status.legalName}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Postal address</dt>
              <dd className="text-right text-ink">{status.postalAddress}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Send mode</dt>
              <dd className="font-mono text-ink">{status.sendMode}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Auto-send</dt>
              <dd className="text-ink">{status.autoSendPermitted ? "permitted" : "not permitted"}</dd>
            </div>
          </dl>
        </article>

        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">Hard caps</h2>
          <p className="mt-3 font-mono text-2xl">
            {status.maxPerInbox ?? "—"} <span className="text-base text-muted">/ inbox</span>
            <span className="mx-2 text-muted">·</span>
            {status.maxTotal ?? "—"} <span className="text-base text-muted">/ day</span>
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Config and the database can lower these. They cannot raise them. Ramp is 9, then 18, then 27 per inbox
            (sending days 1–3, 4–7, then day 8 on). A step-up waits if the previous sending day had a stop. New
            prospects stay at {status.newPerInboxPerDay ?? 9} per inbox per day. A send has to fall inside the
            lead&apos;s local 09:00–17:00 and on a US weekday, 09:00–17:00 Eastern. Hard bounce above 2% of the last
            200, complaint rates of 0.10% and 0.30%, and provider codes 4.7.28, 5.7.515, and 5.7.26 pause sending.
            Looser stop thresholds need an audited override.
          </p>
          <p className="mt-3 font-mono text-xs text-muted">ramp {status.ramp}</p>
        </article>

        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">Connections</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Migration</dt>
              <dd className="font-mono">{status.migrationVersion ?? "none"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Inboxes</dt>
              <dd>{status.inboxes.length} / 15</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Gmail key</dt>
              <dd>{status.gmailKeyConfigured ? "path set" : "not set"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Verification</dt>
              <dd className="text-right">{status.verificationProvider}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">MX pass as valid</dt>
              <dd>{status.treatMxPassAsValid ? "on" : "off"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Unsubscribe URL</dt>
              <dd className="text-right">{status.unsubscribeHttpsBase}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Hosting</dt>
              <dd>{status.hosting}</dd>
            </div>
          </dl>
        </article>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">Tracking and placement</h2>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Open and click tracking exists per campaign and is off by default. Tracking pixels and redirect links
            hurt deliverability of plain-text cold email. Apple Mail Privacy Protection inflates opens. Replies are
            the primary metric.
          </p>
          <p className="mt-3 text-sm leading-relaxed text-muted">
            Inbox placement is stored only as seed-test results. This app does not record or claim placement for
            real recipients.
          </p>
        </article>
        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">How a send stays unique</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-4 text-sm leading-relaxed text-muted">
            <li>Redis holds the queue. Postgres holds the lock. A restart puts an in-flight job back on the queue.</li>
            <li>Contacts collide on normalize_email: lowercase, trim, Gmail dots and +tags.</li>
            <li>The worker inserts a sent-log row before any adapter call. The unique key is contact, campaign, step.</li>
            <li>A killed worker sees that row and does not send the step again. The web process never calls Gmail.</li>
          </ol>
        </article>
      </section>

      {status.alerts.length > 0 ? (
        <section className="mt-8 border border-rust/40 bg-card p-4">
          <h2 className="text-sm font-medium text-rust">Open disconnect alerts</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {status.alerts.map((alert) => (
              <li key={`${alert.email}-${alert.createdAt}`} className="border-l-2 border-rust pl-3">
                <span className="font-mono text-xs">{alert.email}</span>
                <span className="text-muted"> · {alert.createdAt}</span>
                <div>{alert.detail}</div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
          <h2 className="text-sm font-medium">Inboxes</h2>
          <p className="text-xs text-muted">One service account · domain-wide delegation · sync does not modify Gmail</p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(([domain, inboxes]) => (
            <article key={domain} className="border border-line bg-card">
              <header className="border-b border-line px-3 py-2 font-mono text-xs">{domain}</header>
              <ul>
                {inboxes.map((inbox) => (
                  <li key={inbox.email} className="border-b border-line px-3 py-2 last:border-b-0">
                    <div className="break-all font-mono text-xs">{inbox.email}</div>
                    <div className="mt-1 flex justify-between gap-3 text-xs text-muted">
                      <span>{inbox.senderName}</span>
                      <span className="shrink-0">
                        cap {inbox.dailyCap} · {inbox.status.replaceAll("_", " ")}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {inbox.lastSyncAt ? `synced ${inbox.lastSyncAt}` : "not synced"}
                      {" · "}
                      {inbox.historyReady ? `cursor ${inbox.historyId}` : "no cursor"}
                    </div>
                    {inbox.lastError ? <div className="mt-1 text-xs text-rust">{inbox.lastError}</div> : null}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
