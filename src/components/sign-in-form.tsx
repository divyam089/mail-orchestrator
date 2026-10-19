"use client";

import { useState, type FormEvent } from "react";
import { csrfHeaders, errorText } from "@/lib/auth/csrf-client";

export function SignInForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function passwordSignIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: csrfHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ email, password }),
      });
      const data = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(errorText(data, "Sign-in failed"));
        return;
      }
      window.location.assign("/");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/auth/magic", {
        method: "POST",
        headers: csrfHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ email }),
      });
      const data = (await response.json()) as { message?: string; error?: unknown };
      if (!response.ok) {
        setError(errorText(data, "Could not start a magic link"));
        return;
      }
      setNotice(data.message ?? "If that account is invited, a link was prepared. Delivery is TODO: mailer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="mt-8 space-y-3 border-t border-line pt-6" onSubmit={(event) => void passwordSignIn(event)}>
      <p className="text-sm text-muted">Email sign-in is on for this process. It still requires an invite.</p>
      <label className="block text-sm">
        <span className="text-muted">Email</span>
        <input
          type="email"
          required
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="mt-1 w-full border border-line bg-card px-3 py-2"
        />
      </label>
      <label className="block text-sm">
        <span className="text-muted">Password</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="mt-1 w-full border border-line bg-card px-3 py-2"
        />
      </label>
      {error ? <p className="text-sm text-rust">{error}</p> : null}
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-accent px-3 py-2 text-sm text-paper disabled:opacity-50">
          Sign in with password
        </button>
        <button
          type="button"
          disabled={busy || !email}
          className="border border-line bg-card px-3 py-2 text-sm disabled:opacity-50"
          onClick={() => void sendLink()}
        >
          Email me a link
        </button>
      </div>
    </form>
  );
}
