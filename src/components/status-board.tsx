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
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="font-display text-lg leading-none">Figcel Outreach</div>
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
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Step 1 of 8 · Data model</p>
      <h1 className="font-display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">
        Sending is off. The ledger is ready.
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        Fifteen Workspace inboxes, one contact per normalized address, and one sequence send per contact, campaign,
        and step. This screen is the boot check. Inbox sync and the sender are not built yet.
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
            prospects stay at {status.newPerInboxPerDay ?? 9} per inbox per day. Sends run only on US weekdays,
            09:00–17:00 Eastern, and inside 18:30–06:30 IST.
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
            <li>UI, API, and worker all write Postgres. Redis is the later queue, not the source of truth.</li>
            <li>Contacts collide on normalize_email: lowercase, trim, Gmail dots and +tags.</li>
            <li>The sender inserts a sent-log row before any network call. The unique key is contact, campaign, step.</li>
            <li>A retry or a crash sees that row and does not send again. The mock adapter refuses real mail.</li>
          </ol>
        </article>
      </section>

      <section className="mt-8">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-medium">Inboxes</h2>
          <p className="text-xs text-muted">Gmail API · service account · not connected in this step</p>
        </div>
        <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {groups.map(([domain, inboxes]) => (
            <article key={domain} className="border border-line bg-card">
              <header className="border-b border-line px-3 py-2 font-mono text-xs">{domain}</header>
              <ul>
                {inboxes.map((inbox) => (
                  <li key={inbox.email} className="border-b border-line px-3 py-2 last:border-b-0">
                    <div className="font-mono text-xs">{inbox.email}</div>
                    <div className="mt-1 flex justify-between text-xs text-muted">
                      <span>{inbox.senderName}</span>
                      <span>
                        cap {inbox.dailyCap} · {inbox.status.replaceAll("_", " ")}
                      </span>
                    </div>
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
