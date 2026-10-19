"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { ReviewDesk } from "@/lib/send/desk";

export function ReviewDeskView({ initial }: { initial: ReviewDesk }) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");

  async function post(url: string, payload: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { error?: string; reason?: string };
      if (!response.ok) {
        setError(data.error ?? data.reason ?? "Request failed");
        return;
      }
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Review queue</p>
      <h1 className="font-display mt-2 max-w-3xl text-4xl leading-tight sm:text-5xl">
        {initial.approvalMode === "auto" ? "Approval is on. New steps schedule themselves." : "Approval is off. Nothing leaves until you approve it."}
      </h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        The global toggle is {initial.approvalMode}. A campaign can force this queue even when the global toggle is
        auto. Approving a draft does not send while the kill switch is off
        {initial.sendingEnabled ? "" : " — SENDING_ENABLED is false"}. Send mode is {initial.sendMode}.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || initial.approvalMode === "review"}
          className="border border-line bg-card px-3 py-2 text-sm disabled:opacity-50"
          onClick={() => post("/api/approval", { scope: "global", mode: "review" })}
        >
          Approval off
        </button>
        <button
          type="button"
          disabled={busy || initial.approvalMode === "auto"}
          className="border border-line bg-card px-3 py-2 text-sm disabled:opacity-50"
          onClick={() => post("/api/approval", { scope: "global", mode: "auto" })}
        >
          Approval on
        </button>
      </div>
      {initial.blockers.length > 0 ? (
        <ul className="mt-4 max-w-2xl space-y-1 text-sm text-rust">
          {initial.blockers.map((blocker) => (
            <li key={blocker}>{blocker}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-4 text-sm text-rust">{error}</p> : null}

      {initial.drafts.length === 0 ? (
        <p className="mt-10 rounded-xl bg-card px-5 py-8 text-[15px] leading-relaxed text-muted">
          Nothing is waiting. The queue is empty. With approval off, the planner writes a draft here instead of
          sending. With approval on, there is nothing to review.
        </p>
      ) : (
        <>
          <div className="mt-8 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || selected.length === 0}
              className="rounded-md bg-accent px-3 py-2 text-[15px] text-paper disabled:opacity-40"
              onClick={() => post("/api/review/bulk", { ids: selected, action: "approve" })}
            >
              Approve selected
            </button>
            <button
              type="button"
              disabled={busy || selected.length === 0}
              className="border border-line bg-card px-3 py-2 text-sm disabled:opacity-40"
              onClick={() => post("/api/review/bulk", { ids: selected, action: "reject" })}
            >
              Reject selected
            </button>
          </div>
          <ul className="mt-4 space-y-4">
            {initial.drafts.map((draft) => (
              <li key={draft.id} className="rounded-xl bg-card p-5">
                <label className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.includes(draft.id)}
                    onChange={() => toggle(draft.id)}
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs text-muted">
                      {draft.email} · step {draft.stepNumber} · {draft.campaign} · {draft.state}
                      {draft.inbox ? ` · ${draft.inbox}` : ""}
                    </span>
                    <span className="mt-1 block text-lg">{draft.subject}</span>
                  </span>
                </label>
                {editing === draft.id ? (
                  <div className="mt-3 space-y-2">
                    <input
                      className="w-full border border-line bg-paper px-2 py-1 text-sm"
                      value={subject}
                      onChange={(event) => setSubject(event.target.value)}
                      aria-label="Subject"
                    />
                    <textarea
                      className="min-h-40 w-full border border-line bg-paper px-2 py-1 font-mono text-sm"
                      value={body}
                      onChange={(event) => setBody(event.target.value)}
                      aria-label="Body"
                    />
                    <button
                      type="button"
                      disabled={busy}
                      className="border border-ink bg-ink px-3 py-2 text-sm text-paper"
                      onClick={() => post("/api/review", { id: draft.id, action: "edit", subject, body })}
                    >
                      Save edit
                    </button>
                  </div>
                ) : (
                  <pre className="mt-3 whitespace-pre-wrap font-mono text-sm leading-relaxed">{draft.body}</pre>
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="border border-line px-3 py-1 text-sm"
                    onClick={() => {
                      setEditing(draft.id);
                      setSubject(draft.subject);
                      setBody(draft.body);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="border border-ink bg-ink px-3 py-1 text-sm text-paper"
                    onClick={() => post("/api/review", { id: draft.id, action: "approve" })}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className="border border-line px-3 py-1 text-sm"
                    onClick={() => post("/api/review", { id: draft.id, action: "reject" })}
                  >
                    Reject
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">{draft.createdAt}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
