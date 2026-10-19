import type { ThreadDetail, ThreadSummary } from "@/lib/mail/mailbox";
import type { ReplyClass } from "@/lib/mail/classify";

export type MailFilters = {
  q: string;
  inboxId: string;
  view: string;
  label: string;
  campaignId: string;
};

export type ComposeDraft = {
  mode: "reply" | "reply_all" | "forward" | "new";
  to: string;
  cc: string;
  subject: string;
  html: string;
  templateId: string;
};

const CLASS_LABEL: Record<ReplyClass, string> = {
  interested: "Interested",
  not_now: "Not now",
  not_interested: "Not interested",
  ooo: "Out of office",
  unsubscribe: "Unsubscribe",
};

const VIEWS = [
  ["inbox", "Inbox"],
  ["starred", "Starred"],
  ["snoozed", "Snoozed"],
  ["archive", "Archive"],
  ["all", "All"],
] as const;

function classTone(label: ReplyClass): string {
  if (label === "interested") return "border-moss/40 text-moss";
  if (label === "not_now" || label === "ooo") return "border-amber/40 text-amber";
  return "border-rust/40 text-rust";
}

function addresses(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => (item && typeof item === "object" && "email" in item ? String(item.email) : ""))
    .filter(Boolean)
    .join(", ");
}

export function MailboxView({
  threads,
  selectedId,
  detail,
  inboxes,
  campaigns,
  labels,
  templates,
  filters,
  approvalMode,
  pane,
  helpOpen,
  compose,
  notice,
  busy,
  onPane,
  onSelect,
  onHelp,
  onCompose,
  onComposeChange,
  onSend,
  onArchive,
  onStar,
  onRead,
  onSnooze,
  onLabel,
  onClassify,
  onNote,
  onTag,
  onTemplate,
}: {
  threads: ThreadSummary[];
  selectedId: string | null;
  detail: ThreadDetail | null;
  inboxes: { id: string; email: string }[];
  campaigns: { id: string; name: string }[];
  labels: string[];
  templates: { id: string; name: string; subject: string | null; body: string }[];
  filters: MailFilters;
  approvalMode: string;
  pane: "list" | "message" | "context";
  helpOpen: boolean;
  compose: ComposeDraft | null;
  notice: string | null;
  busy: boolean;
  onPane?: (pane: "list" | "message" | "context") => void;
  onSelect?: (id: string) => void;
  onHelp?: (open: boolean) => void;
  onCompose?: (mode: ComposeDraft["mode"] | null) => void;
  onComposeChange?: (patch: Partial<ComposeDraft>) => void;
  onSend?: () => void;
  onArchive?: () => void;
  onStar?: () => void;
  onRead?: (read: boolean) => void;
  onSnooze?: () => void;
  onLabel?: (name: string) => void;
  onClassify?: (messageId: string, label: ReplyClass) => void;
  onNote?: (body: string) => void;
  onTag?: (name: string) => void;
  onTemplate?: (id: string) => void;
}) {
  const approvalOff = approvalMode !== "auto";
  const hidden = (name: "list" | "message" | "context") => (pane === name ? "" : "max-lg:hidden");
  const latest = detail?.messages[detail.messages.length - 1];

  return (
    <main className="mx-auto flex h-[calc(100dvh-7.25rem)] max-w-[96rem] flex-col px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Mailbox</p>
          <h1 className="font-display text-2xl leading-tight sm:text-3xl">Every inbox, one desk</h1>
        </div>
        <p className="max-w-md text-sm text-muted" data-approval={approvalMode}>
          {approvalOff
            ? "Approval is off. A reply is saved as a Review draft. Nothing is sent."
            : "Approval is on. Manual mail still waits on the kill switch and the send mode."}
        </p>
      </div>

      <form action="/mail" method="get" className="mt-3 flex flex-wrap items-end gap-2 border border-line bg-card p-2">
        {selectedId ? <input type="hidden" name="thread" value={selectedId} /> : null}
        <input type="hidden" name="view" value={filters.view} />
        <label className="flex min-w-[10rem] flex-1 flex-col text-[11px] uppercase tracking-[0.12em] text-muted">
          Search
          <input
            id="mail-search"
            name="q"
            defaultValue={filters.q}
            placeholder="Sender, recipient, subject, body"
            className="mt-1 border border-line bg-paper px-2 py-1.5 text-sm normal-case tracking-normal text-ink"
          />
        </label>
        <label className="flex flex-col text-[11px] uppercase tracking-[0.12em] text-muted">
          Inbox
          <select name="inbox" defaultValue={filters.inboxId} className="mt-1 border border-line bg-paper px-2 py-1.5 text-sm normal-case tracking-normal text-ink">
            <option value="">All 15</option>
            {inboxes.map((inbox) => (
              <option key={inbox.id} value={inbox.id}>
                {inbox.email}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] uppercase tracking-[0.12em] text-muted">
          Campaign
          <select name="campaign" defaultValue={filters.campaignId} className="mt-1 max-w-[12rem] border border-line bg-paper px-2 py-1.5 text-sm normal-case tracking-normal text-ink">
            <option value="">Any</option>
            {campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[11px] uppercase tracking-[0.12em] text-muted">
          Label
          <select name="label" defaultValue={filters.label} className="mt-1 border border-line bg-paper px-2 py-1.5 text-sm normal-case tracking-normal text-ink">
            <option value="">Any</option>
            {labels.map((label) => (
              <option key={label} value={label}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="border border-ink bg-ink px-3 py-1.5 text-sm text-paper">
          Show
        </button>
        <button type="button" className="border border-line px-3 py-1.5 text-sm" onClick={() => onHelp?.(true)}>
          Shortcuts
        </button>
      </form>

      <div className="mt-2 flex gap-1 lg:hidden">
        {(["list", "message", "context"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className={`flex-1 border px-2 py-1.5 text-sm capitalize ${pane === name ? "border-ink bg-ink text-paper" : "border-line bg-card"}`}
            onClick={() => onPane?.(name)}
          >
            {name}
          </button>
        ))}
      </div>

      <div className="mt-2 grid min-h-0 flex-1 gap-2 lg:grid-cols-[18rem_minmax(0,1fr)_18rem]">
        <section data-pane="list" className={`flex min-h-0 flex-col border border-line bg-card ${hidden("list")}`}>
          <div className="flex flex-wrap gap-1 border-b border-line p-2">
            {VIEWS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`border px-2 py-0.5 text-xs ${filters.view === value ? "border-ink bg-ink text-paper" : "border-line"}`}
                onClick={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget.closest("main")?.querySelector("form");
                  if (form instanceof HTMLFormElement) {
                    const input = form.querySelector<HTMLInputElement>("input[name=view]");
                    if (input) input.value = value;
                    else {
                      const hidden = document.createElement("input");
                      hidden.type = "hidden";
                      hidden.name = "view";
                      hidden.value = value;
                      form.appendChild(hidden);
                    }
                    form.requestSubmit();
                  }
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {threads.length === 0 ? (
              <p className="p-4 text-sm leading-relaxed text-muted">
                No mail in this view. Sync on the key machine fills these panes. This server does not call Gmail.
              </p>
            ) : (
              <ul>
                {threads.map((thread) => (
                  <li key={thread.id}>
                    <button
                      type="button"
                      data-thread={thread.id}
                      data-selected={thread.id === selectedId ? "true" : "false"}
                      className={`block w-full border-b border-line px-3 py-2 text-left ${thread.id === selectedId ? "bg-paper" : "hover:bg-paper/70"}`}
                      onClick={() => onSelect?.(thread.id)}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className={`truncate text-sm ${thread.unread ? "font-semibold" : ""}`}>
                          {thread.contactEmail ?? thread.subject}
                        </span>
                        {thread.starred ? <span className="text-amber">★</span> : null}
                      </div>
                      <div className="truncate text-sm">{thread.subject}</div>
                      <div className="truncate text-xs text-muted">{thread.snippet}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-muted">
                        <span className="font-mono">{thread.inboxEmail}</span>
                        {thread.classification ? (
                          <span className={`border px-1 ${classTone(thread.classification)}`}>{CLASS_LABEL[thread.classification]}</span>
                        ) : null}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section data-pane="message" data-subject={detail?.subject ?? ""} className={`flex min-h-0 flex-col border border-line bg-card ${hidden("message")}`}>
          {detail ? (
            <>
              <header className="border-b border-line px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="font-display text-xl leading-tight">{detail.subject}</h2>
                  <span className="font-mono text-xs text-muted">{detail.inboxEmail}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onCompose?.("reply")}>
                    Reply
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onCompose?.("reply_all")}>
                    Reply all
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onCompose?.("forward")}>
                    Forward
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onArchive?.()}>
                    Archive
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onStar?.()}>
                    {latest?.isStarred ? "Unstar" : "Star"}
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onRead?.(false)}>
                    Unread
                  </button>
                  <button type="button" className="border border-line px-2 py-1 text-xs" disabled={busy} onClick={() => onSnooze?.()}>
                    Snooze 1 day
                  </button>
                  <LabelBox labels={labels} onLabel={onLabel} />
                </div>
              </header>
              <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
                {detail.messages.map((message) => (
                  <article key={message.id} className="border-b border-line py-3 last:border-b-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                      <div>
                        <span className="font-medium">{message.fromName || message.fromEmail || "Unknown"}</span>{" "}
                        <span className="text-muted">{message.fromEmail}</span>
                      </div>
                      <time className="text-xs text-muted">{message.at}</time>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {message.direction === "out" ? "Sent from" : "Received by"}{" "}
                      <span className="font-mono text-ink">{message.inboxEmail}</span>
                      {addresses(message.to) ? ` · to ${addresses(message.to)}` : ""}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{message.bodyText || "(no body)"}</p>
                    {message.attachments.length > 0 ? (
                      <ul className="mt-2 text-xs text-muted">
                        {message.attachments.map((file) => (
                          <li key={`${message.id}-${file.filename}`}>
                            {file.filename} · {file.mimeType} · {file.sizeBytes ?? 0} bytes
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                ))}
                {compose ? (
                  <ComposeBox
                    compose={compose}
                    templates={templates}
                    approvalOff={approvalOff}
                    busy={busy}
                    onComposeChange={onComposeChange}
                    onTemplate={onTemplate}
                    onSend={onSend}
                    onClose={() => onCompose?.(null)}
                  />
                ) : null}
                {notice ? <p className="mt-3 border border-line bg-paper px-3 py-2 text-sm">{notice}</p> : null}
              </div>
            </>
          ) : (
            <p className="p-4 text-sm text-muted">Select a thread. j and k move the selection. Press ? for the rest.</p>
          )}
        </section>

        <aside
          data-pane="context"
          data-contact={detail?.context.contact?.email ?? ""}
          className={`min-h-0 overflow-auto border border-line bg-card p-3 text-sm ${hidden("context")}`}
        >
          <ContextPane detail={detail} onSelect={onSelect} onClassify={onClassify} onNote={onNote} onTag={onTag} />
        </aside>
      </div>

      {helpOpen ? (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-label="Keyboard shortcuts">
          <div className="w-full max-w-md border border-line bg-card p-5">
            <h2 className="font-display text-2xl">Shortcuts</h2>
            <ul className="mt-3 space-y-1 text-sm">
              <li><kbd>j</kbd> / <kbd>k</kbd> next and previous thread</li>
              <li><kbd>r</kbd> reply · <kbd>a</kbd> reply all · <kbd>f</kbd> forward</li>
              <li><kbd>e</kbd> archive · <kbd>s</kbd> star</li>
              <li><kbd>/</kbd> search · <kbd>?</kbd> or <kbd>Esc</kbd> this list</li>
            </ul>
            <p className="mt-3 text-xs text-muted">Shortcuts stay quiet while you are typing in a field.</p>
            <button type="button" className="mt-4 border border-ink px-3 py-1.5 text-sm" onClick={() => onHelp?.(false)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function LabelBox({ labels, onLabel }: { labels: string[]; onLabel?: (name: string) => void }) {
  return (
    <form
      className="flex gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const name = String(data.get("label") ?? "").trim();
        if (name) onLabel?.(name);
        event.currentTarget.reset();
      }}
    >
      <input name="label" list="mail-labels" placeholder="Label" className="w-24 border border-line bg-paper px-2 py-1 text-xs" />
      <datalist id="mail-labels">
        {labels.map((label) => (
          <option key={label} value={label} />
        ))}
      </datalist>
      <button type="submit" className="border border-line px-2 py-1 text-xs">
        Add
      </button>
    </form>
  );
}

function ComposeBox({
  compose,
  templates,
  approvalOff,
  busy,
  onComposeChange,
  onTemplate,
  onSend,
  onClose,
}: {
  compose: ComposeDraft;
  templates: { id: string; name: string; subject: string | null; body: string }[];
  approvalOff: boolean;
  busy: boolean;
  onComposeChange?: (patch: Partial<ComposeDraft>) => void;
  onTemplate?: (id: string) => void;
  onSend?: () => void;
  onClose: () => void;
}) {
  const title = compose.mode === "reply_all" ? "Reply all" : compose.mode === "forward" ? "Forward" : compose.mode === "new" ? "New message" : "Reply";
  return (
    <form
      className="mt-4 border border-line bg-paper p-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSend?.();
      }}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{title}</h3>
        <button type="button" className="text-xs text-muted" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="mt-1 text-xs text-muted">
        {approvalOff
          ? "Approval is off, so this stays a Review draft. The adapter is not called."
          : "Approval is on. The kill switch and send mode still apply."}{" "}
        HTML is sanitized. A plain-text alternative is stored with it.
      </p>
      <label className="mt-2 block text-xs text-muted">
        Template
        <select
          value={compose.templateId}
          className="mt-1 w-full border border-line bg-card px-2 py-1 text-sm text-ink"
          onChange={(event) => onTemplate?.(event.target.value)}
        >
          <option value="">None</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </select>
      </label>
      <label className="mt-2 block text-xs text-muted">
        To
        <input value={compose.to} onChange={(event) => onComposeChange?.({ to: event.target.value })} className="mt-1 w-full border border-line bg-card px-2 py-1 text-sm text-ink" />
      </label>
      <label className="mt-2 block text-xs text-muted">
        Cc
        <input value={compose.cc} onChange={(event) => onComposeChange?.({ cc: event.target.value })} className="mt-1 w-full border border-line bg-card px-2 py-1 text-sm text-ink" />
      </label>
      <label className="mt-2 block text-xs text-muted">
        Subject
        <input value={compose.subject} onChange={(event) => onComposeChange?.({ subject: event.target.value })} className="mt-1 w-full border border-line bg-card px-2 py-1 text-sm text-ink" />
      </label>
      <div className="mt-2 flex gap-1">
        <button type="button" className="border border-line px-2 py-0.5 text-xs font-semibold" onClick={() => wrap("strong")}>
          Bold
        </button>
        <button type="button" className="border border-line px-2 py-0.5 text-xs italic" onClick={() => wrap("em")}>
          Italic
        </button>
        <button type="button" className="border border-line px-2 py-0.5 text-xs" onClick={() => wrap("a")}>
          Link
        </button>
      </div>
      <label className="mt-2 block text-xs text-muted">
        Message
        <textarea
          id="mail-compose-body"
          value={compose.html}
          onChange={(event) => onComposeChange?.({ html: event.target.value })}
          rows={6}
          className="mt-1 w-full border border-line bg-card px-2 py-1 text-sm text-ink"
        />
      </label>
      <label className="mt-2 block text-xs text-muted">
        Attachments
        <input id="mail-attachments" type="file" multiple className="mt-1 block text-sm" />
      </label>
      <button type="submit" disabled={busy} className="mt-3 border border-ink bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-50">
        {approvalOff ? "Save review draft" : "Send through the gates"}
      </button>
    </form>
  );

  function wrap(tag: "strong" | "em" | "a") {
    const snippet = tag === "a" ? '<a href="https://">link</a>' : `<${tag}></${tag}>`;
    onComposeChange?.({ html: `${compose.html}${snippet}` });
  }
}

function ContextPane({
  detail,
  onSelect,
  onClassify,
  onNote,
  onTag,
}: {
  detail: ThreadDetail | null;
  onSelect?: (id: string) => void;
  onClassify?: (messageId: string, label: ReplyClass) => void;
  onNote?: (body: string) => void;
  onTag?: (name: string) => void;
}) {
  if (!detail) {
    return <p className="text-muted">The context pane follows the selected thread.</p>;
  }
  const contact = detail.context.contact;
  const latest = [...detail.messages].reverse().find((message) => message.direction === "in") ?? detail.messages[detail.messages.length - 1];
  return (
    <div className="space-y-4">
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Lead</h2>
        {contact ? (
          <div className="mt-1">
            <div className="font-medium">{[contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.email}</div>
            <div className="font-mono text-xs">{contact.email}</div>
            <p className="mt-1 text-muted">
              {[contact.title, contact.company].filter(Boolean).join(" · ") || "No company on file"}
            </p>
            <p className="text-xs text-muted">{contact.timezone ?? "America/New_York"}</p>
          </div>
        ) : (
          <p className="mt-1 text-muted">No contact matches this thread.</p>
        )}
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Campaign</h2>
        {detail.context.campaign ? (
          <p className="mt-1">
            {detail.context.campaign.name} · step {detail.context.campaign.step}
            {detail.context.campaign.variant ? ` · ${detail.context.campaign.variant}` : ""} · {detail.context.campaign.status}
          </p>
        ) : (
          <p className="mt-1 text-muted">No campaign is tied to this thread.</p>
        )}
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Classification</h2>
        {latest ? (
          <select
            className="mt-1 w-full border border-line bg-paper px-2 py-1"
            value={latest.classification ?? ""}
            onChange={(event) => {
              const value = event.target.value as ReplyClass;
              if (value) onClassify?.(latest.id, value);
            }}
          >
            <option value="">Unlabeled</option>
            {(Object.keys(CLASS_LABEL) as ReplyClass[]).map((label) => (
              <option key={label} value={label}>
                {CLASS_LABEL[label]}
              </option>
            ))}
          </select>
        ) : null}
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Timeline</h2>
        {detail.context.timeline.length === 0 ? (
          <p className="mt-1 text-muted">No sends or replies recorded.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {detail.context.timeline.map((event) => (
              <li key={`${event.at}-${event.kind}`}>
                <span className="font-medium">{event.kind}</span> <span className="text-xs text-muted">{event.at}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Verification</h2>
        <p className="mt-1">
          {detail.context.verification
            ? `${detail.context.verification.status}${detail.context.verification.provider ? ` · ${detail.context.verification.provider}` : ""}`
            : "Not checked"}
        </p>
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Sending inbox</h2>
        <p className="mt-1 font-mono text-xs">{detail.context.inbox.email}</p>
        <p>
          {detail.context.inbox.status} · {detail.context.inbox.sentToday}/{detail.context.inbox.cap} today
          {detail.context.inbox.pause ? ` · paused (${detail.context.inbox.pause})` : ""}
        </p>
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Other threads</h2>
        {detail.context.otherThreads.length === 0 ? (
          <p className="mt-1 text-muted">None with this contact.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {detail.context.otherThreads.map((thread) => (
              <li key={thread.id}>
                <button type="button" className="text-left underline decoration-line" onClick={() => onSelect?.(thread.id)}>
                  {thread.subject}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Notes</h2>
        <ul className="mt-1 space-y-1">
          {detail.context.notes.map((note) => (
            <li key={note.id}>
              {note.body} <span className="text-xs text-muted">{note.at}</span>
            </li>
          ))}
        </ul>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const body = String(data.get("body") ?? "").trim();
            if (body) onNote?.(body);
            event.currentTarget.reset();
          }}
        >
          <input name="body" placeholder="Add a note" className="min-w-0 flex-1 border border-line bg-paper px-2 py-1" />
          <button type="submit" className="border border-line px-2 py-1 text-xs">
            Save
          </button>
        </form>
      </section>
      <section>
        <h2 className="text-[11px] uppercase tracking-[0.14em] text-muted">Tags</h2>
        <div className="mt-1 flex flex-wrap gap-1">
          {detail.context.tags.map((tag) => (
            <span key={tag} className="border border-line px-1.5 py-0.5 text-xs">
              {tag}
            </span>
          ))}
        </div>
        <form
          className="mt-2 flex gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const name = String(data.get("tag") ?? "").trim();
            if (name) onTag?.(name);
            event.currentTarget.reset();
          }}
        >
          <input name="tag" placeholder="Add a tag" className="min-w-0 flex-1 border border-line bg-paper px-2 py-1" />
          <button type="submit" className="border border-line px-2 py-1 text-xs">
            Add
          </button>
        </form>
      </section>
    </div>
  );
}
