import { UI_ACTIONS, scopesForRole } from "@/lib/api/actions";
import { API_ERROR_CODES } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const EXAMPLES = [
  `curl -s http://127.0.0.1:43123/api/v1/openapi.json`,
  `curl -s http://127.0.0.1:43123/api/v1/campaigns \\
  -H "authorization: Bearer $FIGCEL_API_KEY"`,
  `curl -s http://127.0.0.1:43123/api/v1/campaigns \\
  -H "authorization: Bearer $FIGCEL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"name":"Harbor intro"}'`,
  `curl -s http://127.0.0.1:43123/api/v1/imports \\
  -H "authorization: Bearer $FIGCEL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"source":"paste","text":"ada@example.test,Ada,Example"}'`,
  `curl -s http://127.0.0.1:43123/api/v1/approval \\
  -H "authorization: Bearer $FIGCEL_API_KEY" \\
  -H "content-type: application/json" \\
  -d '{"scope":"global","mode":"review"}'`,
  `curl -s http://127.0.0.1:43123/api/v1/mail/messages \\
  -H "authorization: Bearer $FIGCEL_API_KEY" \\
  -H "content-type: application/json" \\
  -H "idempotency-key: compose-1" \\
  -d '{"inboxEmail":"divyam@usefigcel.com","to":["ada@example.test"],"subject":"Hello","text":"Hello"}'`,
  `curl -N http://127.0.0.1:43123/api/v1/events \\
  -H "authorization: Bearer $FIGCEL_API_KEY"`,
];

export default function ApiDocsPage() {
  const groups = new Map<string, typeof UI_ACTIONS>();
  for (const action of UI_ACTIONS) {
    const list = groups.get(action.ui) ?? [];
    list.push(action);
    groups.set(action.ui, list);
  }
  return (
    <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Step 7 of 8 · API</p>
      <h1 className="font-display mt-2 text-4xl leading-tight sm:text-5xl">API v1</h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
        Every UI action is a route under <span className="font-mono text-ink">/api/v1</span>. Keys are SHA-256 hashed
        and carry the admin, operator, or viewer role. Sends use the same approval toggle, caps, ramp, window,
        suppression, stop rules, and kill switch as the desk. The machine-readable spec is{" "}
        <a className="text-ink underline decoration-line underline-offset-2" href="/api/v1/openapi.json">
          /api/v1/openapi.json
        </a>
        .
      </p>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted">
        An assistant listens on <span className="font-mono text-ink">GET /api/v1/events</span>. That stream is the
        dashboard bus: a reply, a bounce, an inbox pause, or a draft waiting in Review. Outbound webhooks are not
        called from this process.
      </p>
      <section className="mt-8 border border-line bg-card p-4">
        <h2 className="text-sm font-medium">Example calls</h2>
        <p className="mt-2 text-xs text-muted">Set FIGCEL_API_KEY to a secret from the admin key desk. It is shown once.</p>
        <div className="mt-3 space-y-3">
          {EXAMPLES.map((example) => (
            <pre key={example} className="overflow-x-auto whitespace-pre-wrap font-mono text-xs leading-relaxed">
              {example}
            </pre>
          ))}
        </div>
      </section>
      <section className="mt-8">
        <h2 className="text-sm font-medium">Errors</h2>
        <p className="mt-2 font-mono text-xs text-muted">{API_ERROR_CODES.join(" · ")}</p>
        <pre className="mt-3 overflow-x-auto border border-line bg-card p-3 font-mono text-xs">{`{ "error": { "code": "gate_blocked", "message": "…" } }`}</pre>
      </section>
      <section className="mt-8">
        <h2 className="text-sm font-medium">Roles</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {(["viewer", "operator", "admin"] as const).map((role) => (
            <li key={role} className="border border-line bg-card px-3 py-2">
              <span className="font-medium">{role}</span>
              <span className="mt-1 block font-mono text-xs text-muted">{scopesForRole(role).join(" ")}</span>
            </li>
          ))}
        </ul>
      </section>
      {[...groups.entries()].map(([name, actions]) => (
        <section key={name} className="mt-8">
          <h2 className="text-sm font-medium">{name}</h2>
          <ul className="mt-3 divide-y divide-line border border-line bg-card">
            {actions.map((action) => (
              <li key={action.id} className="px-3 py-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-mono text-xs text-rust">{action.method}</span>
                  <span className="font-mono text-sm">/api/v1{action.path}</span>
                </div>
                <p className="mt-1 text-sm text-muted">
                  {action.summary}. Role {action.role}. Scope {action.scope}.
                  {action.idempotent ? " Requires Idempotency-Key." : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
