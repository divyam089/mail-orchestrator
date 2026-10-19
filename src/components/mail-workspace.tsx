"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { ReplyClass } from "@/lib/mail/classify";
import type { ThreadDetail, ThreadSummary } from "@/lib/mail/mailbox";
import { moveSelection, shortcutFor } from "@/lib/mail/shortcuts";
import { MailboxView, type ComposeDraft, type MailFilters } from "@/components/mailbox-view";

type Template = { id: string; name: string; subject: string | null; body: string };

export function MailWorkspace({
  threads,
  detail,
  inboxes,
  campaigns,
  labels,
  templates,
  filters,
  approvalMode,
}: {
  threads: ThreadSummary[];
  detail: ThreadDetail | null;
  inboxes: { id: string; email: string }[];
  campaigns: { id: string; name: string }[];
  labels: string[];
  templates: Template[];
  filters: MailFilters;
  approvalMode: string;
}) {
  const router = useRouter();
  const [rows, setRows] = useState(threads);
  const [selectedId, setSelectedId] = useState<string | null>(detail?.id ?? threads[0]?.id ?? null);
  const [current, setCurrent] = useState<ThreadDetail | null>(detail);
  const [pane, setPane] = useState<"list" | "message" | "context">("list");
  const [helpOpen, setHelpOpen] = useState(false);
  const [compose, setCompose] = useState<ComposeDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRows(threads);
    setCurrent(detail);
    setSelectedId(detail?.id ?? threads[0]?.id ?? null);
  }, [threads, detail]);

  const actions = useRef<{
    rows: ThreadSummary[];
    selectedId: string | null;
    openThread: (id: string) => Promise<void>;
    openCompose: (mode: ComposeDraft["mode"]) => void;
    act: (payload: Record<string, unknown>) => Promise<void>;
  }>({
    rows,
    selectedId,
    openThread: async () => undefined,
    openCompose: () => undefined,
    act: async () => undefined,
  });

  async function openThread(id: string) {
    setSelectedId(id);
    setPane("message");
    setCompose(null);
    setNotice(null);
    const response = await fetch(`/api/mail/threads/${id}`);
    if (!response.ok) return;
    const next = (await response.json()) as ThreadDetail;
    setCurrent(next);
    setRows((list) => list.map((row) => (row.id === id ? { ...row, unread: false } : row)));
    const url = new URL(window.location.href);
    url.searchParams.set("thread", id);
    window.history.replaceState(null, "", url);
  }

  function openCompose(mode: ComposeDraft["mode"]) {
    if (!current) return;
    const last = current.messages[current.messages.length - 1];
    const counterparty =
      last?.fromEmail && last.fromEmail !== current.inboxEmail ? last.fromEmail : addresses(last?.to)[0] ?? "";
    const everyone = [last?.fromEmail, ...addresses(last?.to), ...addresses(last?.cc)].filter(
      (item): item is string => typeof item === "string" && item.toLowerCase() !== current.inboxEmail,
    );
    const subjectBase = current.subject.replace(/^(re|fwd):\s*/i, "");
    setCompose({
      mode,
      to: mode === "forward" ? "" : counterparty,
      cc: mode === "reply_all" ? everyone.filter((item) => item !== counterparty).join(", ") : "",
      subject: mode === "forward" ? `Fwd: ${subjectBase}` : `Re: ${subjectBase}`,
      html: "",
      templateId: "",
    });
    setPane("message");
  }

  async function act(payload: Record<string, unknown>) {
    if (!selectedId) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/mail/threads/${selectedId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setNotice(data.error ?? "Could not update the thread");
        return;
      }
      if (payload.action === "archive" || payload.action === "snooze") {
        router.refresh();
      } else {
        await openThread(selectedId);
      }
    } finally {
      setBusy(false);
    }
  }

  actions.current = { rows, selectedId, openThread, openCompose, act };

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = Boolean(
        target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable),
      );
      const action = shortcutFor(event.key, typing);
      if (!action) return;
      const api = actions.current;
      event.preventDefault();
      if (action === "help") {
        setHelpOpen((open) => !open);
        return;
      }
      if (action === "search") {
        document.getElementById("mail-search")?.focus();
        return;
      }
      if (action === "next" || action === "previous") {
        const index = api.rows.findIndex((row) => row.id === api.selectedId);
        const next = moveSelection(api.rows.length, index < 0 ? 0 : index, action === "next" ? 1 : -1);
        const thread = api.rows[next];
        if (thread) void api.openThread(thread.id);
        return;
      }
      if (action === "reply") api.openCompose("reply");
      if (action === "reply_all") api.openCompose("reply_all");
      if (action === "forward") api.openCompose("forward");
      if (action === "archive") void api.act({ action: "archive" });
      if (action === "star") void api.act({ action: "star", starred: !api.rows.find((row) => row.id === api.selectedId)?.starred });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function send() {
    if (!compose || !current) return;
    setBusy(true);
    setNotice(null);
    try {
      const files = await readFiles();
      const last = current.messages[current.messages.length - 1];
      const response = await fetch("/api/mail/compose", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          inboxEmail: current.inboxEmail,
          mode: compose.mode,
          sourceMessageId: last?.id,
          to: splitList(compose.to),
          cc: splitList(compose.cc),
          subject: compose.subject,
          html: compose.html || "<p></p>",
          attachments: files,
        }),
      });
      const data = (await response.json()) as { error?: string; outcome?: string; reason?: string };
      if (!response.ok) {
        setNotice(data.error ?? "Compose failed");
        return;
      }
      if (data.outcome === "drafted") {
        setNotice("Saved as a Review draft. Nothing left this machine.");
        setCompose(null);
      } else {
        setNotice(data.reason ?? data.outcome ?? "Held");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <MailboxView
      threads={rows}
      selectedId={selectedId}
      detail={current}
      inboxes={inboxes}
      campaigns={campaigns}
      labels={labels}
      templates={templates}
      filters={filters}
      approvalMode={approvalMode}
      pane={pane}
      helpOpen={helpOpen}
      compose={compose}
      notice={notice}
      busy={busy}
      onPane={setPane}
      onSelect={(id) => void openThread(id)}
      onHelp={setHelpOpen}
      onCompose={(mode) => {
        if (!mode) setCompose(null);
        else openCompose(mode);
      }}
      onComposeChange={(patch) => setCompose((currentDraft) => (currentDraft ? { ...currentDraft, ...patch } : currentDraft))}
      onSend={() => void send()}
      onArchive={() => void act({ action: "archive" })}
      onStar={() => void act({ action: "star", starred: !rows.find((row) => row.id === selectedId)?.starred })}
      onRead={(read) => void act({ action: "read", read })}
      onSnooze={() => void act({ action: "snooze", hours: 24 })}
      onLabel={(name) => void act({ action: "label", name })}
      onClassify={(messageId, label) => void act({ action: "classify", messageId, classification: label satisfies ReplyClass })}
      onNote={async (body) => {
        const contactId = current?.context.contact?.id;
        if (!contactId) return;
        await fetch(`/api/mail/contacts/${contactId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "note", body }),
        });
        if (selectedId) await openThread(selectedId);
      }}
      onTag={async (name) => {
        const contactId = current?.context.contact?.id;
        if (!contactId) return;
        await fetch(`/api/mail/contacts/${contactId}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "tag", name }),
        });
        if (selectedId) await openThread(selectedId);
      }}
      onTemplate={(id) => {
        const template = templates.find((item) => item.id === id);
        setCompose((currentDraft) =>
          currentDraft
            ? {
                ...currentDraft,
                templateId: id,
                subject: template?.subject || currentDraft.subject,
                html: template?.body ?? currentDraft.html,
              }
            : currentDraft,
        );
      }}
    />
  );
}

function addresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item && typeof item === "object" && "email" in item ? String(item.email) : ""))
    .filter(Boolean);
}

function splitList(value: string): string[] {
  return value
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function readFiles(): Promise<{ filename: string; mimeType: string; contentBase64: string }[]> {
  const input = document.getElementById("mail-attachments");
  if (!(input instanceof HTMLInputElement) || !input.files) return [];
  const files = [...input.files].slice(0, 3);
  const encoded = [];
  for (const file of files) {
    const data = await file.arrayBuffer();
    const bytes = new Uint8Array(data);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    encoded.push({ filename: file.name, mimeType: file.type || "application/octet-stream", contentBase64: btoa(binary) });
  }
  return encoded;
}
