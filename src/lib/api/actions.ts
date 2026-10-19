export type ApiRole = "admin" | "operator" | "viewer";
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type UiAction = {
  id: string;
  ui: string;
  method: HttpMethod;
  path: string;
  role: ApiRole;
  scope: string;
  idempotent: boolean;
  summary: string;
};

/**
 * Every UI action, plus the campaign and inbox controls the assistant uses.
 * The parity test fails when an id has no handler or the OpenAPI document omits it.
 */
export const UI_ACTIONS: UiAction[] = [
  { id: "campaigns.list", ui: "Campaigns", method: "GET", path: "/campaigns", role: "viewer", scope: "campaigns.read", idempotent: false, summary: "List campaigns" },
  { id: "campaigns.create", ui: "Campaigns", method: "POST", path: "/campaigns", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Create a campaign" },
  { id: "campaigns.read", ui: "Campaigns", method: "GET", path: "/campaigns/{id}", role: "viewer", scope: "campaigns.read", idempotent: false, summary: "Read a campaign, its steps, and its variants" },
  { id: "campaigns.update", ui: "Campaigns", method: "PATCH", path: "/campaigns/{id}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Update a campaign" },
  { id: "campaigns.archive", ui: "Campaigns", method: "DELETE", path: "/campaigns/{id}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Archive a campaign" },
  { id: "steps.create", ui: "Sequences", method: "POST", path: "/campaigns/{id}/steps", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Add a sequence step" },
  { id: "steps.update", ui: "Sequences", method: "PATCH", path: "/campaigns/{id}/steps/{stepId}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Update a step delay" },
  { id: "steps.delete", ui: "Sequences", method: "DELETE", path: "/campaigns/{id}/steps/{stepId}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Delete a step and its variants" },
  { id: "variants.create", ui: "Sequences", method: "POST", path: "/campaigns/{id}/steps/{stepId}/variants", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Add a step variant" },
  { id: "variants.update", ui: "Sequences", method: "PATCH", path: "/campaigns/{id}/steps/{stepId}/variants/{variantId}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Update a variant" },
  { id: "variants.delete", ui: "Sequences", method: "DELETE", path: "/campaigns/{id}/steps/{stepId}/variants/{variantId}", role: "operator", scope: "campaigns.write", idempotent: false, summary: "Delete a variant" },
  { id: "imports.create", ui: "Import", method: "POST", path: "/imports", role: "operator", scope: "imports.write", idempotent: false, summary: "Import leads and return the dedupe report" },
  { id: "imports.read", ui: "Import", method: "GET", path: "/imports/{id}", role: "viewer", scope: "imports.read", idempotent: false, summary: "Read a stored dedupe report" },
  { id: "verification.read", ui: "Import", method: "GET", path: "/contacts/{id}/verification", role: "viewer", scope: "verification.read", idempotent: false, summary: "Read verification status" },
  { id: "holds.list", ui: "Import", method: "GET", path: "/holds", role: "viewer", scope: "verification.read", idempotent: false, summary: "List verification holds" },
  { id: "holds.decide", ui: "Import", method: "POST", path: "/holds/{id}", role: "operator", scope: "verification.write", idempotent: false, summary: "Approve or reject a hold" },
  { id: "suppression.list", ui: "Suppression", method: "GET", path: "/suppression", role: "viewer", scope: "suppression.read", idempotent: false, summary: "List suppressions" },
  { id: "suppression.add", ui: "Suppression", method: "POST", path: "/suppression", role: "operator", scope: "suppression.write", idempotent: false, summary: "Suppress an address or a domain" },
  { id: "approval.set", ui: "Review", method: "POST", path: "/approval", role: "operator", scope: "approval.write", idempotent: false, summary: "Set the global or per-campaign approval toggle" },
  { id: "review.list", ui: "Review", method: "GET", path: "/review", role: "viewer", scope: "review.read", idempotent: false, summary: "List the review queue" },
  { id: "review.edit", ui: "Review", method: "POST", path: "/review/{id}/edit", role: "operator", scope: "review.write", idempotent: false, summary: "Edit a draft" },
  { id: "review.approve", ui: "Review", method: "POST", path: "/review/{id}/approve", role: "operator", scope: "review.write", idempotent: true, summary: "Approve a draft through the same gates as the UI" },
  { id: "review.reject", ui: "Review", method: "POST", path: "/review/{id}/reject", role: "operator", scope: "review.write", idempotent: false, summary: "Reject a draft" },
  { id: "review.bulk", ui: "Review", method: "POST", path: "/review/bulk", role: "operator", scope: "review.write", idempotent: true, summary: "Approve or reject many drafts" },
  { id: "inboxes.list", ui: "Inboxes", method: "GET", path: "/inboxes", role: "viewer", scope: "inboxes.read", idempotent: false, summary: "List inboxes" },
  { id: "inboxes.pause", ui: "Inboxes", method: "POST", path: "/inboxes/{id}/pause", role: "operator", scope: "inboxes.write", idempotent: false, summary: "Pause an inbox and record the stop rule" },
  { id: "inboxes.resume", ui: "Inboxes", method: "POST", path: "/inboxes/{id}/resume", role: "operator", scope: "inboxes.write", idempotent: false, summary: "Resume an inbox pause" },
  { id: "inboxes.health", ui: "Dashboard", method: "GET", path: "/inboxes/{id}/health", role: "viewer", scope: "inboxes.read", idempotent: false, summary: "Inbox health from the ledger" },
  { id: "mail.search", ui: "Mail", method: "GET", path: "/mail/threads", role: "viewer", scope: "mail.read", idempotent: false, summary: "Search mail" },
  { id: "mail.thread", ui: "Mail", method: "GET", path: "/mail/threads/{id}", role: "viewer", scope: "mail.read", idempotent: false, summary: "Read a thread" },
  { id: "mail.compose", ui: "Mail", method: "POST", path: "/mail/messages", role: "operator", scope: "mail.write", idempotent: true, summary: "Compose a new message" },
  { id: "mail.reply", ui: "Mail", method: "POST", path: "/mail/threads/{id}/reply", role: "operator", scope: "mail.write", idempotent: true, summary: "Reply, reply all, or forward" },
  { id: "mail.archive", ui: "Mail", method: "POST", path: "/mail/threads/{id}/archive", role: "operator", scope: "mail.write", idempotent: false, summary: "Archive a thread" },
  { id: "mail.star", ui: "Mail", method: "POST", path: "/mail/threads/{id}/star", role: "operator", scope: "mail.write", idempotent: false, summary: "Star or unstar a thread" },
  { id: "mail.read", ui: "Mail", method: "POST", path: "/mail/threads/{id}/read", role: "operator", scope: "mail.write", idempotent: false, summary: "Mark a thread read or unread" },
  { id: "mail.snooze", ui: "Mail", method: "POST", path: "/mail/threads/{id}/snooze", role: "operator", scope: "mail.write", idempotent: false, summary: "Snooze a thread" },
  { id: "mail.label", ui: "Mail", method: "POST", path: "/mail/threads/{id}/label", role: "operator", scope: "mail.write", idempotent: false, summary: "Label the latest message" },
  { id: "mail.classify", ui: "Mail", method: "POST", path: "/mail/threads/{id}/classify", role: "operator", scope: "mail.write", idempotent: false, summary: "Relabel a message classification" },
  { id: "mail.note", ui: "Mail", method: "POST", path: "/contacts/{id}/notes", role: "operator", scope: "mail.write", idempotent: false, summary: "Add a contact note" },
  { id: "mail.tag", ui: "Mail", method: "POST", path: "/contacts/{id}/tags", role: "operator", scope: "mail.write", idempotent: false, summary: "Add or remove a contact tag" },
  { id: "templates.list", ui: "Mail", method: "GET", path: "/templates", role: "viewer", scope: "mail.read", idempotent: false, summary: "List reply templates" },
  { id: "templates.save", ui: "Mail", method: "POST", path: "/templates", role: "operator", scope: "mail.write", idempotent: false, summary: "Save a reply template" },
  { id: "dashboard.metrics", ui: "Dashboard", method: "GET", path: "/dashboard", role: "viewer", scope: "dashboard.read", idempotent: false, summary: "Dashboard metrics for a date range" },
  { id: "dashboard.export", ui: "Dashboard", method: "GET", path: "/dashboard/export", role: "viewer", scope: "dashboard.read", idempotent: false, summary: "CSV export of a dashboard table" },
  { id: "alerts.list", ui: "Dashboard", method: "GET", path: "/alerts", role: "viewer", scope: "alerts.read", idempotent: false, summary: "Disconnects, pauses, stale sync, and failed jobs" },
  { id: "events.stream", ui: "Dashboard", method: "GET", path: "/events", role: "viewer", scope: "events.read", idempotent: false, summary: "SSE for reply, bounce, pause, and review drafts" },
  { id: "keys.list", ui: "Admin keys", method: "GET", path: "/keys", role: "admin", scope: "keys.manage", idempotent: false, summary: "List API keys" },
  { id: "keys.create", ui: "Admin keys", method: "POST", path: "/keys", role: "admin", scope: "keys.manage", idempotent: false, summary: "Create an API key. The secret is returned once." },
  { id: "keys.revoke", ui: "Admin keys", method: "POST", path: "/keys/{id}/revoke", role: "admin", scope: "keys.manage", idempotent: false, summary: "Revoke an API key" },
];

const READ_SCOPES = [
  "campaigns.read",
  "imports.read",
  "verification.read",
  "suppression.read",
  "review.read",
  "inboxes.read",
  "mail.read",
  "dashboard.read",
  "alerts.read",
  "events.read",
];

const WRITE_SCOPES = [
  "campaigns.write",
  "imports.write",
  "verification.write",
  "suppression.write",
  "approval.write",
  "review.write",
  "inboxes.write",
  "mail.write",
];

export function scopesForRole(role: ApiRole): string[] {
  if (role === "admin") return [...READ_SCOPES, ...WRITE_SCOPES, "keys.manage"];
  if (role === "operator") return [...READ_SCOPES, ...WRITE_SCOPES];
  return [...READ_SCOPES];
}

export function roleAllows(role: ApiRole, action: UiAction, keyScopes: string[]): boolean {
  const allowed = new Set(scopesForRole(role));
  if (!allowed.has(action.scope)) return false;
  if (keyScopes.length === 0) return true;
  return keyScopes.includes(action.scope);
}

export function findAction(method: string, path: string): { action: UiAction; params: Record<string, string> } | null {
  for (const action of UI_ACTIONS) {
    if (action.method !== method) continue;
    const params = matchPath(action.path, path);
    if (params) return { action, params };
  }
  return null;
}

export function matchPath(template: string, path: string): Record<string, string> | null {
  const expected = template.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  if (expected.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const token = expected[i];
    if (token.startsWith("{") && token.endsWith("}")) params[token.slice(1, -1)] = decodeURIComponent(actual[i]);
    else if (token !== actual[i]) return null;
  }
  return params;
}
