"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type KeyRow = {
  id: string;
  name: string;
  prefix: string;
  role: string;
  scopes: string[];
  rate_limit_per_minute: number;
  revoked_at: string | null;
};

export function KeyDesk({ keys }: { keys: unknown[] }) {
  const router = useRouter();
  const rows = keys as KeyRow[];
  const [name, setName] = useState("");
  const [role, setRole] = useState("operator");
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createKey() {
    setBusy(true);
    setError(null);
    setSecret(null);
    try {
      const response = await fetch("/api/keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, role }),
      });
      const data = (await response.json()) as { secret?: string; error?: { message?: string } | string };
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : data.error?.message;
        setError(message ?? "Could not create the key");
        return;
      }
      setSecret(data.secret ?? null);
      setName("");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/keys/${id}/revoke`, { method: "POST" });
      if (!response.ok) setError("Could not revoke the key");
      else router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <form
        className="flex flex-col gap-3 border border-line bg-card p-4 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void createKey();
        }}
      >
        <label className="text-xs text-muted">
          Name
          <input
            className="mt-1 block w-full border border-line bg-paper px-2 py-1.5 text-sm text-ink"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="text-xs text-muted">
          Role
          <select
            className="mt-1 block border border-line bg-paper px-2 py-1.5 text-sm text-ink"
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            <option value="viewer">viewer</option>
            <option value="operator">operator</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button className="border border-ink bg-ink px-3 py-1.5 text-sm text-paper disabled:opacity-50" disabled={busy || !name.trim()} type="submit">
          Create key
        </button>
      </form>
      {secret ? (
        <p className="mt-4 border border-amber/40 bg-card px-3 py-3 text-sm">
          Copy this secret now. It is not stored. <span className="mt-1 block break-all font-mono text-xs">{secret}</span>
        </p>
      ) : null}
      {error ? <p className="mt-4 text-sm text-rust">{error}</p> : null}
      <ul className="mt-6 divide-y divide-line border border-line bg-card">
        {rows.length === 0 ? <li className="px-3 py-4 text-sm text-muted">no data yet</li> : null}
        {rows.map((key) => (
          <li key={key.id} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm">{key.name}</div>
              <div className="font-mono text-xs text-muted">
                {key.prefix}… · {key.role} · {key.rate_limit_per_minute}/min
                {key.revoked_at ? " · revoked" : ""}
              </div>
            </div>
            {key.revoked_at ? null : (
              <button className="border border-line px-3 py-1.5 text-sm" type="button" disabled={busy} onClick={() => void revoke(key.id)}>
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
