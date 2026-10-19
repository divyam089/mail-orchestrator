import type { ReactNode } from "react";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

export function DashboardView({
  data,
  live = "connecting",
}: {
  data: DashboardSnapshot;
  live?: "connecting" | "live" | "reconnecting";
}) {
  const approval =
    data.approvalMode === "review" ? "Review queue · OFF" : data.approvalMode === "auto" ? "Auto-send ON" : data.approvalMode;
  const staleSync = data.alerts.sync.filter((row) => row.state !== "fresh");
  return (
    <main className="mx-auto max-w-[96rem] px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Step 6 of 8 · Live dashboard</p>
          <h1 className="font-display mt-2 text-4xl leading-tight sm:text-5xl">Today’s ledger</h1>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
            Counts come from Postgres. A missing source stays blank. This page does not invent a zero.
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
          <p
            data-live={live}
            className={`border px-3 py-2 text-xs uppercase tracking-[0.14em] ${
              live === "live" ? "border-moss/40 text-moss" : live === "reconnecting" ? "border-rust/40 text-rust" : "border-amber/40 text-amber"
            }`}
          >
            {live === "live" ? "Live" : live === "reconnecting" ? "Reconnecting" : "Connecting"}
          </p>
          <form action="/dashboard" method="get" className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              From
              <input
                className="mt-1 block border border-line bg-card px-2 py-1.5 text-sm text-ink"
                type="date"
                name="from"
                defaultValue={data.from}
              />
            </label>
            <label className="text-xs text-muted">
              To
              <input
                className="mt-1 block border border-line bg-card px-2 py-1.5 text-sm text-ink"
                type="date"
                name="to"
                defaultValue={data.to}
              />
            </label>
            <button className="border border-ink bg-ink px-3 py-1.5 text-sm text-paper" type="submit">
              Apply
            </button>
          </form>
        </div>
      </div>

      <p className="mt-4 border border-line bg-card px-4 py-3 text-sm" role="status">
        Approval is <span className="font-medium">{approval}</span>. The kill switch stays in the banner above. Range{" "}
        <span className="font-mono">
          {data.from} → {data.to}
        </span>
        . Caps below are today, {data.today}, even when the range is wider.
      </p>

      <section className="mt-6">
        <SectionHead title="Range totals" view="summary" data={data} />
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Sent" value={String(data.totals.sent)} />
          <Metric label="Delivered" value={String(data.totals.delivered)} hint="Sent minus bounces" />
          <Metric label="Hard bounces" value={String(data.totals.hardBounces)} />
          <Metric label="Soft bounces" value={String(data.totals.softBounces)} />
          <Metric label="Replies" value={String(data.totals.replies)} />
          <Metric label="Positive replies" value={String(data.totals.positiveReplies)} hint="Classified interested" />
          <Metric label="Unsubscribes" value={String(data.totals.unsubscribes)} />
          <Metric label="Complaints" value={data.totals.complaints == null ? "no source" : String(data.totals.complaints)} />
          <Metric label="Opens" value={data.tracking.opens == null ? "tracking off" : String(data.tracking.opens)} />
          <Metric label="Clicks" value={data.tracking.clicks == null ? "tracking off" : String(data.tracking.clicks)} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">{data.tracking.note}</p>
      </section>

      <section className="mt-8 grid gap-4 lg:grid-cols-2">
        <article className="border border-line bg-card p-4">
          <h2 className="text-sm font-medium">Queue depth</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <Row label="Ready" value={data.queue.ready == null ? "unavailable" : String(data.queue.ready)} />
            <Row label="Processing" value={data.queue.processing == null ? "unavailable" : String(data.queue.processing)} />
            <Row label="Review drafts" value={String(data.queue.reviewDrafts)} />
          </dl>
          <p className="mt-3 text-xs text-muted">Ready and processing are Redis list lengths. Review drafts are Postgres rows.</p>
        </article>
        <article className="border border-line bg-card p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-sm font-medium">Caps today</h2>
            <CsvLink view="caps" data={data} />
          </div>
          <p className="mt-3 font-mono text-2xl">
            {data.caps.fleetUsed}
            <span className="text-base text-muted"> / {data.caps.fleetCap}</span>
            <span className="ml-2 text-sm text-muted">fleet</span>
          </p>
          <p className="mt-2 text-sm text-muted">
            Hard max {data.caps.perInboxHardMax}/inbox and {data.caps.fleetHardMax} fleet. Ramp {data.caps.ramp}.
          </p>
        </article>
      </section>

      <TableSection title="Per inbox" view="by-inbox" data={data}>
        <table className="w-full min-w-[48rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.12em] text-muted">
            <tr>
              <Th>Inbox</Th>
              <Th>Sent</Th>
              <Th>Delivered</Th>
              <Th>Hard</Th>
              <Th>Soft</Th>
              <Th>Replies</Th>
              <Th>Positive</Th>
              <Th>Unsubs</Th>
            </tr>
          </thead>
          <tbody>
            {data.byInbox.map((row) => (
              <tr key={row.email} className="border-t border-line">
                <Td className="font-mono text-xs">{row.email}</Td>
                <Td>{row.sent}</Td>
                <Td>{row.delivered}</Td>
                <Td>{row.hardBounces}</Td>
                <Td>{row.softBounces}</Td>
                <Td>{row.replies}</Td>
                <Td>{row.positiveReplies}</Td>
                <Td>{row.unsubscribes}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableSection>

      <TableSection title="Cap used vs today’s ramp" view="caps" data={data}>
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-[0.12em] text-muted">
            <tr>
              <Th>Inbox</Th>
              <Th>Used</Th>
              <Th>Ramp cap</Th>
              <Th>Ramp day</Th>
            </tr>
          </thead>
          <tbody>
            {data.caps.inboxes.map((row) => (
              <tr key={row.email} className="border-t border-line">
                <Td className="font-mono text-xs">{row.email}</Td>
                <Td>
                  {row.used} / {row.cap}
                </Td>
                <Td>{row.cap}</Td>
                <Td>{row.rampDay}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </TableSection>

      <TableSection title="Per campaign" view="by-campaign" data={data}>
        {data.byCampaign.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-muted">
              <tr>
                <Th>Campaign</Th>
                <Th>Sent</Th>
                <Th>Delivered</Th>
                <Th>Hard</Th>
                <Th>Soft</Th>
                <Th>Replies</Th>
                <Th>Positive</Th>
                <Th>Unsubs</Th>
                <Th>Opens</Th>
                <Th>Clicks</Th>
                <Th>Tracking</Th>
              </tr>
            </thead>
            <tbody>
              {data.byCampaign.map((row) => (
                <tr key={row.campaign} className="border-t border-line">
                  <Td>{row.campaign}</Td>
                  <Td>{row.sent}</Td>
                  <Td>{row.delivered}</Td>
                  <Td>{row.hardBounces}</Td>
                  <Td>{row.softBounces}</Td>
                  <Td>{row.replies}</Td>
                  <Td>{row.positiveReplies}</Td>
                  <Td>{row.unsubscribes}</Td>
                  <Td>{row.opens == null ? "tracking off" : row.opens}</Td>
                  <Td>{row.clicks == null ? "tracking off" : row.clicks}</Td>
                  <Td>{row.tracking}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableSection>

      <TableSection title="Per day" view="by-day" data={data}>
        {data.byDay.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-muted">
              <tr>
                <Th>Day</Th>
                <Th>Sent</Th>
                <Th>Hard</Th>
                <Th>Soft</Th>
                <Th>Replies</Th>
                <Th>Unsubs</Th>
              </tr>
            </thead>
            <tbody>
              {data.byDay.map((row) => (
                <tr key={row.day} className="border-t border-line">
                  <Td className="font-mono text-xs">{row.day}</Td>
                  <Td>{row.sent}</Td>
                  <Td>{row.hardBounces}</Td>
                  <Td>{row.softBounces}</Td>
                  <Td>{row.replies}</Td>
                  <Td>{row.unsubscribes}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableSection>

      <TableSection title="Campaign funnel" view="funnel" data={data}>
        {data.funnel.length === 0 ? (
          <Empty />
        ) : (
          <table className="w-full min-w-[48rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-muted">
              <tr>
                <Th>Campaign</Th>
                <Th>Step</Th>
                <Th>Variant</Th>
                <Th>Sent</Th>
                <Th>Hard</Th>
                <Th>Soft</Th>
                <Th>Replies</Th>
                <Th>Positive</Th>
                <Th>Unsubs</Th>
              </tr>
            </thead>
            <tbody>
              {data.funnel.map((row) => (
                <tr key={`${row.campaign}-${row.step}-${row.variant}`} className="border-t border-line">
                  <Td>{row.campaign}</Td>
                  <Td>{row.step}</Td>
                  <Td>{row.variant}</Td>
                  <Td>{row.sent}</Td>
                  <Td>{row.hardBounces}</Td>
                  <Td>{row.softBounces}</Td>
                  <Td>{row.replies}</Td>
                  <Td>{row.positiveReplies}</Td>
                  <Td>{row.unsubscribes}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableSection>

      <section className="mt-8">
        <SectionHead title="Inbox health" view="health" data={data} />
        <p className="mt-2 text-xs text-muted">Unsubscribe sync: {data.unsubSync}</p>
        <div className="mt-3 overflow-x-auto border border-line bg-card">
          <table className="w-full min-w-[64rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-[0.12em] text-muted">
              <tr>
                <Th>Inbox</Th>
                <Th>Status</Th>
                <Th>Pause</Th>
                <Th>Bounce rate</Th>
                <Th>Last sync</Th>
                <Th>Seed placement</Th>
                <Th>Warmup</Th>
              </tr>
            </thead>
            <tbody>
              {data.health.map((row) => (
                <tr key={row.email} className="border-t border-line align-top">
                  <Td className="font-mono text-xs">{row.email}</Td>
                  <Td>{row.status.replaceAll("_", " ")}</Td>
                  <Td>{row.pause ?? "not paused"}</Td>
                  <Td>{row.bounceRate}</Td>
                  <Td>{row.lastSync ?? "no sync yet"}</Td>
                  <Td>{row.seedPlacement}</Td>
                  <Td>{row.warmup}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8">
        <SectionHead title="Alerts" view="alerts" data={data} />
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <AlertList
            title="Inbox disconnect"
            empty={data.alerts.disconnects.length === 0}
            rows={data.alerts.disconnects.map((row) => ({
              key: `${row.email}-${row.at}-${row.detail}`,
              title: row.email ?? "inbox",
              detail: row.detail,
              at: row.at,
            }))}
          />
          <AlertList
            title="Stop-rule pauses"
            empty={data.alerts.pauses.length === 0}
            rows={data.alerts.pauses.map((row) => ({
              key: `${row.scope}-${row.target}-${row.rule}`,
              title: `${row.scope} · ${row.target}`,
              detail: `${row.rule}${row.detail ? ` · ${row.detail}` : ""}`,
              at: row.at,
            }))}
          />
          <AlertList
            title="Stale sync"
            empty={staleSync.length === 0}
            rows={staleSync.map((row) => ({
              key: row.email,
              title: row.email,
              detail: row.state,
              at: row.lastSync ?? "",
            }))}
          />
          <AlertList
            title="Failed jobs"
            empty={data.alerts.failedJobs.length === 0}
            rows={data.alerts.failedJobs.map((row) => ({
              key: `${row.inbox}-${row.at}`,
              title: row.inbox,
              detail: row.error ?? "failed",
              at: row.at,
            }))}
          />
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <article className="border border-line bg-card px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</div>
      <div className="mt-1 font-mono text-xl">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted">{hint}</div> : null}
    </article>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono">{value}</dd>
    </div>
  );
}

function CsvLink({ view, data }: { view: string; data: DashboardSnapshot }) {
  return (
    <a
      className="text-xs text-muted underline decoration-line underline-offset-2"
      href={`/api/dashboard/export?view=${view}&from=${data.from}&to=${data.to}`}
    >
      CSV
    </a>
  );
}

function SectionHead({ title, view, data }: { title: string; view: string; data: DashboardSnapshot }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-sm font-medium">{title}</h2>
      <CsvLink view={view} data={data} />
    </div>
  );
}

function TableSection({
  title,
  view,
  data,
  children,
}: {
  title: string;
  view: string;
  data: DashboardSnapshot;
  children: ReactNode;
}) {
  return (
    <section className="mt-8">
      <SectionHead title={title} view={view} data={data} />
      <div className="mt-3 overflow-x-auto border border-line bg-card">{children}</div>
    </section>
  );
}

function Th({ children }: { children: ReactNode }) {
  return <th className="px-3 py-2 font-medium">{children}</th>;
}

function Td({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <td className={`px-3 py-2 ${className}`}>{children}</td>;
}

function Empty() {
  return <p className="px-3 py-4 text-sm text-muted">no data yet</p>;
}

function AlertList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: boolean;
  rows: { key: string; title: string; detail: string; at: string }[];
}) {
  return (
    <article className="border border-line bg-card p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      {empty ? (
        <p className="mt-3 text-sm text-muted">no data yet</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {rows.map((row) => (
            <li key={row.key} className="border-l-2 border-rust pl-3">
              <div className="font-mono text-xs">{row.title}</div>
              <div>{row.detail}</div>
              {row.at ? <div className="text-xs text-muted">{row.at}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
