"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SignOutControls } from "@/components/sign-out-controls";
import { csrfHeaders, errorText } from "@/lib/auth/csrf-client";
import { LOGIN_DOMAINS, type Role } from "@/lib/auth/roles";

export type TeamUser = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  last_sign_in_at: string | null;
};

function signedIn(value: string | null): string {
  if (!value) return "no sign-in yet";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function TeamDesk({
  users,
  restricted,
  localLogin,
}: {
  users: TeamUser[];
  restricted: boolean;
  localLogin: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/team", {
        method: "POST",
        headers: csrfHeaders({ "content-type": "application/json" }),
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(errorText(data, "Could not update the team"));
        return;
      }
      setEmail("");
      setPassword("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Admin · Team</p>
      <h1 className="font-display mt-2 text-4xl">Team</h1>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted">
        Invite a partner by email and choose a role. They can sign in with Google after that. A viewer reads. An
        operator runs campaigns, approves review drafts, and replies under the same gates as the desk. An admin also
        manages people, keys, inboxes, and the approval toggle. The kill switch stays in the environment. This page
        cannot turn sending on.
      </p>

      <form
        className="mt-8 flex flex-col gap-3 rounded-xl bg-card p-5 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void post({ action: "invite", email, role, password: password || undefined });
        }}
      >
        <label className="min-w-0 flex-1 text-sm">
          <span className="text-muted">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="mt-1 w-full border border-line bg-paper px-3 py-2"
            placeholder="partner@usefigcel.com"
          />
        </label>
        <label className="text-sm">
          <span className="text-muted">Role</span>
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as Role)}
            className="mt-1 w-full border border-line bg-paper px-3 py-2"
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </label>
        {localLogin ? (
          <label className="text-sm">
            <span className="text-muted">Password, optional</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-1 w-full border border-line bg-paper px-3 py-2"
            />
          </label>
        ) : null}
        <button type="submit" disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm text-paper disabled:opacity-50">
          Invite
        </button>
      </form>
      {error ? <p className="mt-3 text-sm text-rust">{error}</p> : null}

      {users.length === 0 ? (
        <p className="mt-8 rounded-xl bg-card px-5 py-8 text-[15px] leading-relaxed text-muted">
          Nobody is on the team yet. The first admin comes from BOOTSTRAP_ADMIN_EMAIL.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-line rounded-xl bg-card">
          {users.map((person) => (
            <li key={person.id} className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="truncate font-medium">{person.email}</div>
                <div className="mt-1 text-sm text-muted">
                  {person.status} · last sign-in {signedIn(person.last_sign_in_at)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm text-muted">
                  Role
                  <select
                    className="ml-2 border border-line bg-paper px-2 py-1 text-ink"
                    value={person.role}
                    disabled={busy}
                    onChange={(event) => void post({ action: "role", userId: person.id, role: event.target.value })}
                  >
                    <option value="viewer">viewer</option>
                    <option value="operator">operator</option>
                    <option value="admin">admin</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy}
                  className="border border-line px-3 py-1 text-sm disabled:opacity-50"
                  onClick={() => {
                    if (window.confirm(`Remove ${person.email}?`)) void post({ action: "remove", userId: person.id });
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <section className="mt-8 rounded-xl bg-card p-5">
        <h2 className="text-sm font-medium">Sign-in domains</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Off means any invited email can sign in. On limits invites and sign-in to {LOGIN_DOMAINS.join(", ")}.
        </p>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={restricted}
            disabled={busy}
            onChange={(event) => void post({ action: "domains", restrict: event.target.checked })}
          />
          Restrict sign-in to the five Figcel domains
        </label>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-medium">This browser</h2>
        <p className="mt-2 text-sm text-muted">Sign out everywhere ends every session for this account, including this one.</p>
        <div className="mt-3">
          <SignOutControls />
        </div>
      </section>
    </main>
  );
}
