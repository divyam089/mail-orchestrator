"use client";

import { csrfHeaders } from "@/lib/auth/csrf-client";

async function post(url: string) {
  const response = await fetch(url, { method: "POST", headers: csrfHeaders() });
  if (response.ok) window.location.assign("/sign-in");
}

export function SignOutControls({ compact = false }: { compact?: boolean }) {
  const className = compact
    ? "text-muted underline decoration-line/80 underline-offset-4"
    : "border border-line bg-card px-3 py-2 text-sm";
  return (
    <div className={compact ? "flex flex-wrap gap-x-4 gap-y-1 text-sm" : "flex flex-wrap gap-2"}>
      <button type="button" className={className} onClick={() => void post("/api/auth/sign-out")}>
        Sign out
      </button>
      <button type="button" className={className} onClick={() => void post("/api/auth/sign-out-all")}>
        Sign out everywhere
      </button>
    </div>
  );
}
