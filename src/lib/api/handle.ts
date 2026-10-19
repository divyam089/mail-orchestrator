import { createHash } from "node:crypto";
import type { Db } from "@/lib/db/pool";
import { findAction, roleAllows, type UiAction } from "@/lib/api/actions";
import { ApiError, errorBody } from "@/lib/api/errors";
import { authenticateApiKey, createApiKey, listApiKeys, revokeApiKey, type ApiKeyRecord } from "@/lib/api/keys";
import { takeRateToken } from "@/lib/api/rate";
import { CSV_VIEWS, snapshotCsv, type CsvView } from "@/lib/dashboard/csv";
import { loadDashboard, parseRange } from "@/lib/dashboard/snapshot";
import { normalizeEmail } from "@/lib/email/normalize";
import { readSendMode, readSendingEnabled, type ApprovalMode } from "@/lib/gates";
import { MockMailAdapter } from "@/lib/mail/adapter";
import { REPLY_CLASSES, type ReplyClass } from "@/lib/mail/classify";
import { composeManual } from "@/lib/mail/compose";
import {
  addNote,
  applyLabel,
  listTemplates,
  listThreads,
  loadThread,
  relabelMessage,
  saveTemplate,
  setMessageState,
  setTag,
  setThreadArchived,
  setThreadRead,
  setThreadStar,
} from "@/lib/mail/mailbox";
import { decideHold } from "@/lib/contacts/holds";
import { importLeads, type ImportSource } from "@/lib/contacts/import";
import { parsePaste, mapCsv, type FieldMapping } from "@/lib/contacts/parse-leads";
import { loadReviewDesk } from "@/lib/send/desk";
import { bulkDecide, decideDraft, editDraft, setApprovalMode } from "@/lib/send/review";
import { audit } from "@/lib/send/settings";
import { pause, resumeInbox } from "@/lib/send/stops";
import type { DnsResolver } from "@/lib/verify/dns";
import { createNodeDnsResolver } from "@/lib/verify/node-dns";

export type ApiResult = { status: number; body: unknown; headers?: Record<string, string> };

export type ApiCall = {
  method: string;
  path: string;
  headers: { get(name: string): string | null };
  body: unknown;
  search: URLSearchParams;
};

type Ctx = {
  db: Db;
  actor: string;
  key: ApiKeyRecord;
  params: Record<string, string>;
  body: Record<string, unknown>;
  search: URLSearchParams;
  action: UiAction;
};

const handlers: Record<string, (ctx: Ctx) => Promise<ApiResult>> = {
  "campaigns.list": listCampaigns,
  "campaigns.create": createCampaign,
  "campaigns.read": readCampaign,
  "campaigns.update": updateCampaign,
  "campaigns.archive": archiveCampaign,
  "steps.create": createStep,
  "steps.update": updateStep,
  "steps.delete": deleteStep,
  "variants.create": createVariant,
  "variants.update": updateVariant,
  "variants.delete": deleteVariant,
  "imports.create": createImport,
  "imports.read": readImport,
  "verification.read": readVerification,
  "holds.list": listHolds,
  "holds.decide": decideHoldAction,
  "suppression.list": listSuppression,
  "suppression.add": addSuppression,
  "approval.set": setApproval,
  "review.list": listReview,
  "review.edit": editReview,
  "review.approve": (ctx) => decideReview(ctx, "approve"),
  "review.reject": (ctx) => decideReview(ctx, "reject"),
  "review.bulk": bulkReview,
  "inboxes.list": listInboxes,
  "inboxes.pause": pauseInbox,
  "inboxes.resume": resumeOneInbox,
  "inboxes.health": inboxHealth,
  "mail.search": searchMail,
  "mail.thread": readThread,
  "mail.compose": composeMail,
  "mail.reply": replyMail,
  "mail.archive": (ctx) => threadFlag(ctx, "archive"),
  "mail.star": (ctx) => threadFlag(ctx, "star"),
  "mail.read": (ctx) => threadFlag(ctx, "read"),
  "mail.snooze": snoozeThread,
  "mail.label": labelThread,
  "mail.classify": classifyThread,
  "mail.note": noteContact,
  "mail.tag": tagContact,
  "templates.list": async (ctx) => ok(await listTemplates(ctx.db)),
  "templates.save": saveOneTemplate,
  "dashboard.metrics": dashboardMetrics,
  "dashboard.export": dashboardExport,
  "alerts.list": listAlerts,
  "events.stream": async () => ok({ transport: "sse", path: "/api/v1/events" }),
  "keys.list": async (ctx) => ok(await listApiKeys(ctx.db)),
  "keys.create": createKey,
  "keys.revoke": revokeKey,
};

let resolverOverride: DnsResolver | null = null;

/** Tests inject a fake resolver so an import does not query DNS. */
export function setApiDnsResolver(resolver: DnsResolver | null): void {
  resolverOverride = resolver;
}

export function apiHandlers(): Record<string, (ctx: Ctx) => Promise<ApiResult>> {
  return handlers;
}

export async function handleApiV1(db: Db, call: ApiCall): Promise<ApiResult> {
  const method = call.method.toUpperCase();
  const path = call.path.startsWith("/") ? call.path : `/${call.path}`;
  const found = findAction(method, path);
  if (!found) throw new ApiError(404, "not_found", `No ${method} ${path}`);
  const key = await authenticateApiKey(db, call.headers.get("authorization"));
  if (!takeRateToken(key.id, key.rateLimitPerMinute)) {
    throw new ApiError(429, "rate_limited", `Rate limit is ${key.rateLimitPerMinute} requests per minute`);
  }
  if (!roleAllows(key.role, found.action, key.scopes)) {
    throw new ApiError(403, "forbidden", `${key.role} cannot ${found.action.id}`);
  }
  const body = isRecord(call.body) ? call.body : {};
  const actor = `api:${key.name}`;
  const ctx: Ctx = { db, actor, key, params: found.params, body, search: call.search, action: found.action };
  if (found.action.idempotent) {
    const replay = await loadIdempotency(ctx, call.headers.get("idempotency-key"));
    if (replay) {
      await audit(db, {
        source: "api",
        actor,
        action: found.action.id,
        entityType: "api",
        entityId: key.id,
        detail: { status: replay.status, path, replay: true },
      });
      return replay;
    }
  }
  const handler = handlers[found.action.id];
  if (!handler) throw new ApiError(500, "internal", `${found.action.id} has no handler`);
  const result = await handler(ctx);
  await audit(db, {
    source: "api",
    actor,
    action: found.action.id,
    entityType: "api",
    entityId: key.id,
    detail: { status: result.status, path },
  });
  if (found.action.idempotent) await storeIdempotency(ctx, call.headers.get("idempotency-key"), result);
  return result;
}

export function toApiResult(error: unknown): ApiResult {
  if (error instanceof ApiError) return { status: error.status, body: errorBody(error.code, error.message) };
  const message = error instanceof Error ? error.message : "Request failed";
  return { status: 500, body: errorBody("internal", message) };
}

async function loadIdempotency(ctx: Ctx, header: string | null): Promise<ApiResult | null> {
  const key = header?.trim() ?? "";
  if (!key) throw new ApiError(400, "idempotency_required", "Idempotency-Key is required on this POST");
  const hash = requestHash(ctx);
  const existing = await ctx.db.query<{ request_hash: string; status_code: number; response: unknown }>(
    `SELECT request_hash, status_code, response FROM api_idempotency WHERE key_id = $1 AND idempotency_key = $2`,
    [ctx.key.id, key],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_hash !== hash) {
    throw new ApiError(409, "idempotency_conflict", "Idempotency-Key was already used with a different body");
  }
  return { status: row.status_code, body: row.response };
}

async function storeIdempotency(ctx: Ctx, header: string | null, result: ApiResult): Promise<void> {
  const key = header?.trim() ?? "";
  if (!key) return;
  await ctx.db.query(
    `INSERT INTO api_idempotency (key_id, idempotency_key, request_hash, status_code, response)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (key_id, idempotency_key) DO NOTHING`,
    [ctx.key.id, key, requestHash(ctx), result.status, JSON.stringify(result.body)],
  );
}

function requestHash(ctx: Ctx): string {
  return createHash("sha256").update(JSON.stringify({ path: ctx.action.path, params: ctx.params, body: ctx.body })).digest("hex");
}

function ok(body: unknown, status = 200, headers?: Record<string, string>): ApiResult {
  return { status, body, headers };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ApiError(400, "validation", `${field} is required`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ApiError(400, "validation", `${field} must be a uuid`);
  }
  return value;
}

async function listCampaigns(ctx: Ctx): Promise<ApiResult> {
  const rows = await ctx.db.query(
    `SELECT id, name, status, approval_override, track_opens, track_clicks, timezone_mode, created_at
     FROM campaigns ORDER BY created_at DESC`,
  );
  return ok(rows.rows);
}

async function createCampaign(ctx: Ctx): Promise<ApiResult> {
  const name = text(ctx.body.name, "name").slice(0, 200);
  const inserted = await ctx.db.query(
    `INSERT INTO campaigns (name, track_opens, track_clicks, timezone_mode)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, status, track_opens, track_clicks, timezone_mode`,
    [name, ctx.body.trackOpens === true, ctx.body.trackClicks === true, ctx.body.timezoneMode === "et" ? "et" : "lead"],
  );
  return ok(inserted.rows[0], 201);
}

async function readCampaign(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const campaign = await ctx.db.query(`SELECT * FROM campaigns WHERE id = $1`, [id]);
  if (!campaign.rows[0]) throw new ApiError(404, "not_found", "campaign not found");
  const steps = await ctx.db.query(
    `SELECT s.id, s.step_number, s.delay_business_days,
            COALESCE(json_agg(json_build_object('id', v.id, 'variantKey', v.variant_key, 'subjectTemplate', v.subject_template, 'bodyTemplate', v.body_template, 'weight', v.weight)
              ORDER BY v.variant_key) FILTER (WHERE v.id IS NOT NULL), '[]') AS variants
     FROM sequence_steps s
     LEFT JOIN step_variants v ON v.step_id = s.id
     WHERE s.campaign_id = $1
     GROUP BY s.id
     ORDER BY s.step_number`,
    [id],
  );
  return ok({ ...campaign.rows[0], steps: steps.rows });
}

async function updateCampaign(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const current = await ctx.db.query<{ name: string; status: string; track_opens: boolean; track_clicks: boolean }>(
    `SELECT name, status, track_opens, track_clicks FROM campaigns WHERE id = $1`,
    [id],
  );
  if (!current.rows[0]) throw new ApiError(404, "not_found", "campaign not found");
  const status = optionalText(ctx.body.status) ?? current.rows[0].status;
  if (!["draft", "active", "paused", "completed", "archived"].includes(status)) {
    throw new ApiError(400, "validation", "status is not a campaign status");
  }
  const updated = await ctx.db.query(
    `UPDATE campaigns
     SET name = $2, status = $3, track_opens = $4, track_clicks = $5, updated_at = now()
     WHERE id = $1
     RETURNING id, name, status, track_opens, track_clicks`,
    [
      id,
      optionalText(ctx.body.name) ?? current.rows[0].name,
      status,
      typeof ctx.body.trackOpens === "boolean" ? ctx.body.trackOpens : current.rows[0].track_opens,
      typeof ctx.body.trackClicks === "boolean" ? ctx.body.trackClicks : current.rows[0].track_clicks,
    ],
  );
  return ok(updated.rows[0]);
}

async function archiveCampaign(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const updated = await ctx.db.query(
    `UPDATE campaigns SET status = 'archived', updated_at = now() WHERE id = $1 RETURNING id, status`,
    [id],
  );
  if (!updated.rows[0]) throw new ApiError(404, "not_found", "campaign not found");
  return ok(updated.rows[0]);
}

async function createStep(ctx: Ctx): Promise<ApiResult> {
  const campaignId = uuid(ctx.params.id, "id");
  const stepNumber = numberField(ctx.body.stepNumber, "stepNumber");
  const delay = ctx.body.delayBusinessDays == null ? 0 : numberField(ctx.body.delayBusinessDays, "delayBusinessDays");
  const inserted = await ctx.db.query(
    `INSERT INTO sequence_steps (campaign_id, step_number, delay_business_days)
     VALUES ($1, $2, $3) RETURNING id, step_number, delay_business_days`,
    [campaignId, stepNumber, delay],
  );
  return ok(inserted.rows[0], 201);
}

async function updateStep(ctx: Ctx): Promise<ApiResult> {
  const delay = numberField(ctx.body.delayBusinessDays, "delayBusinessDays");
  const updated = await ctx.db.query(
    `UPDATE sequence_steps SET delay_business_days = $2
     WHERE id = $1 AND campaign_id = $3
     RETURNING id, step_number, delay_business_days`,
    [uuid(ctx.params.stepId, "stepId"), delay, uuid(ctx.params.id, "id")],
  );
  if (!updated.rows[0]) throw new ApiError(404, "not_found", "step not found");
  return ok(updated.rows[0]);
}

async function deleteStep(ctx: Ctx): Promise<ApiResult> {
  const deleted = await ctx.db.query(`DELETE FROM sequence_steps WHERE id = $1 AND campaign_id = $2`, [
    uuid(ctx.params.stepId, "stepId"),
    uuid(ctx.params.id, "id"),
  ]);
  if ((deleted.rowCount ?? 0) === 0) throw new ApiError(404, "not_found", "step not found");
  return ok({ deleted: true });
}

async function createVariant(ctx: Ctx): Promise<ApiResult> {
  const inserted = await ctx.db.query(
    `INSERT INTO step_variants (step_id, variant_key, subject_template, body_template, weight)
     SELECT s.id, $2, $3, $4, $5 FROM sequence_steps s WHERE s.id = $1 AND s.campaign_id = $6
     RETURNING id, variant_key, subject_template, body_template, weight`,
    [
      uuid(ctx.params.stepId, "stepId"),
      text(ctx.body.variantKey, "variantKey"),
      optionalText(ctx.body.subjectTemplate),
      text(ctx.body.bodyTemplate, "bodyTemplate"),
      ctx.body.weight == null ? 1 : numberField(ctx.body.weight, "weight"),
      uuid(ctx.params.id, "id"),
    ],
  );
  if (!inserted.rows[0]) throw new ApiError(404, "not_found", "step not found");
  return ok(inserted.rows[0], 201);
}

async function updateVariant(ctx: Ctx): Promise<ApiResult> {
  const updated = await ctx.db.query(
    `UPDATE step_variants v
     SET subject_template = COALESCE($2, v.subject_template),
         body_template = COALESCE($3, v.body_template),
         weight = COALESCE($4, v.weight)
     FROM sequence_steps s
     WHERE v.id = $1 AND v.step_id = s.id AND s.id = $5 AND s.campaign_id = $6
     RETURNING v.id, v.variant_key, v.subject_template, v.body_template, v.weight`,
    [
      uuid(ctx.params.variantId, "variantId"),
      optionalText(ctx.body.subjectTemplate),
      optionalText(ctx.body.bodyTemplate),
      ctx.body.weight == null ? null : numberField(ctx.body.weight, "weight"),
      uuid(ctx.params.stepId, "stepId"),
      uuid(ctx.params.id, "id"),
    ],
  );
  if (!updated.rows[0]) throw new ApiError(404, "not_found", "variant not found");
  return ok(updated.rows[0]);
}

async function deleteVariant(ctx: Ctx): Promise<ApiResult> {
  const deleted = await ctx.db.query(
    `DELETE FROM step_variants v USING sequence_steps s
     WHERE v.id = $1 AND v.step_id = s.id AND s.id = $2 AND s.campaign_id = $3`,
    [uuid(ctx.params.variantId, "variantId"), uuid(ctx.params.stepId, "stepId"), uuid(ctx.params.id, "id")],
  );
  if ((deleted.rowCount ?? 0) === 0) throw new ApiError(404, "not_found", "variant not found");
  return ok({ deleted: true });
}

async function createImport(ctx: Ctx): Promise<ApiResult> {
  const source = ctx.body.source;
  if (source !== "csv" && source !== "paste") throw new ApiError(400, "validation", "source must be csv or paste");
  const raw = text(ctx.body.text, "text");
  const mapping = isRecord(ctx.body.mapping) ? (ctx.body.mapping as FieldMapping) : { email: "email" };
  const records = source === "csv" ? mapCsv(raw, mapping) : parsePaste(raw);
  const tags = Array.isArray(ctx.body.tags) ? ctx.body.tags.filter((tag): tag is string => typeof tag === "string") : [];
  const report = await importLeads(ctx.db, {
    source: "api" as ImportSource,
    label: optionalText(ctx.body.label) ?? `API ${source}`,
    records,
    mapping: source === "csv" ? mapping : null,
    tags,
    campaignId: optionalText(ctx.body.campaignId),
    resolver: resolverOverride ?? createNodeDnsResolver(),
  });
  return ok(report, 201);
}

async function readImport(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const header = await ctx.db.query(`SELECT id, source, label, created_at FROM imports WHERE id = $1`, [id]);
  if (!header.rows[0]) throw new ApiError(404, "not_found", "import not found");
  const rows = await ctx.db.query(
    `SELECT line_number, raw_email, normalized_email, contact_id, outcome, detail
     FROM import_rows WHERE import_id = $1 ORDER BY line_number`,
    [id],
  );
  return ok({ ...header.rows[0], rows: rows.rows });
}

async function readVerification(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const contact = await ctx.db.query(
    `SELECT id, display_email, verification_status FROM contacts WHERE id = $1`,
    [id],
  );
  if (!contact.rows[0]) throw new ApiError(404, "not_found", "contact not found");
  const latest = await ctx.db.query(
    `SELECT provider, status, syntax_ok, mx_ok, is_role, is_disposable, checked_at
     FROM verification_results WHERE contact_id = $1 ORDER BY checked_at DESC LIMIT 1`,
    [id],
  );
  return ok({ ...contact.rows[0], latest: latest.rows[0] ?? null });
}

async function listHolds(ctx: Ctx): Promise<ApiResult> {
  const rows = await ctx.db.query(
    `SELECT id, contact_id, campaign_id, status, verification_status, created_at
     FROM verification_holds ORDER BY created_at DESC LIMIT 100`,
  );
  return ok(rows.rows);
}

async function decideHoldAction(ctx: Ctx): Promise<ApiResult> {
  const action = ctx.body.action === "approve" || ctx.body.action === "reject" ? ctx.body.action : null;
  if (!action) throw new ApiError(400, "validation", "action must be approve or reject");
  const result = await decideHold(ctx.db, { holdId: uuid(ctx.params.id, "id"), action, actor: ctx.actor, source: "api" });
  if (!result.ok) throw new ApiError(404, "not_found", result.reason);
  return ok(result);
}

async function listSuppression(ctx: Ctx): Promise<ApiResult> {
  const rows = await ctx.db.query(`SELECT id, kind, value, reason, source, created_at FROM suppression ORDER BY created_at DESC`);
  return ok(rows.rows);
}

async function addSuppression(ctx: Ctx): Promise<ApiResult> {
  const kind = ctx.body.kind === "domain" ? "domain" : ctx.body.kind === "email" ? "email" : null;
  if (!kind) throw new ApiError(400, "validation", "kind must be email or domain");
  const raw = text(ctx.body.value, "value");
  const value = kind === "email" ? normalizeEmail(raw) : raw.toLowerCase();
  if (!value) throw new ApiError(400, "validation", "value is not a valid email");
  const reason = text(ctx.body.reason, "reason");
  const inserted = await ctx.db.query(
    `INSERT INTO suppression (kind, value, reason, source) VALUES ($1, $2, $3, 'api')
     ON CONFLICT (kind, value) DO NOTHING
     RETURNING id, kind, value, reason`,
    [kind, value, reason],
  );
  if (!inserted.rows[0]) throw new ApiError(409, "conflict", "that suppression already exists");
  return ok(inserted.rows[0], 201);
}

async function setApproval(ctx: Ctx): Promise<ApiResult> {
  const scope = ctx.body.scope === "global" || ctx.body.scope === "campaign" ? ctx.body.scope : null;
  const mode = ctx.body.mode === "review" || ctx.body.mode === "auto" ? (ctx.body.mode as ApprovalMode) : null;
  if (!scope || !mode) throw new ApiError(400, "validation", "scope and mode are required");
  const result = await setApprovalMode(ctx.db, {
    scope,
    mode,
    campaignId: optionalText(ctx.body.campaignId) ?? undefined,
    source: "api",
    actor: ctx.actor,
  });
  return ok(result);
}

async function listReview(ctx: Ctx): Promise<ApiResult> {
  return ok(await loadReviewDesk(ctx.db));
}

async function editReview(ctx: Ctx): Promise<ApiResult> {
  const result = await editDraft(ctx.db, {
    id: uuid(ctx.params.id, "id"),
    subject: text(ctx.body.subject, "subject"),
    body: text(ctx.body.body, "body"),
    actor: ctx.actor,
    source: "api",
  });
  if (!result.ok) throw new ApiError(409, "conflict", result.reason);
  return ok(result);
}

async function decideReview(ctx: Ctx, action: "approve" | "reject"): Promise<ApiResult> {
  const result = await decideDraft(ctx.db, {
    id: uuid(ctx.params.id, "id"),
    action,
    actor: ctx.actor,
    source: "api",
    adapter: new MockMailAdapter(),
    sendingEnabled: readSendingEnabled(),
    sendMode: readSendMode(),
  });
  if (!result.ok) throw new ApiError(409, "gate_blocked", result.reason);
  return ok(result);
}

async function bulkReview(ctx: Ctx): Promise<ApiResult> {
  const action = ctx.body.action === "approve" || ctx.body.action === "reject" ? ctx.body.action : null;
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.filter((id): id is string => typeof id === "string") : [];
  if (!action || ids.length === 0) throw new ApiError(400, "validation", "ids and action are required");
  const results = await bulkDecide(ctx.db, {
    ids,
    action,
    actor: ctx.actor,
    source: "api",
    adapter: new MockMailAdapter(),
    sendingEnabled: readSendingEnabled(),
    sendMode: readSendMode(),
  });
  return ok({ results });
}

async function listInboxes(ctx: Ctx): Promise<ApiResult> {
  const rows = await ctx.db.query(
    `SELECT id, email, sender_name, domain, status, daily_cap, last_sync_at, last_error, warmup_status, warmup_source
     FROM inboxes ORDER BY email`,
  );
  return ok(rows.rows);
}

async function pauseInbox(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const inbox = await ctx.db.query<{ id: string; email: string }>(`SELECT id, email FROM inboxes WHERE id = $1`, [id]);
  if (!inbox.rows[0]) throw new ApiError(404, "not_found", "inbox not found");
  const detail = text(ctx.body.detail, "detail");
  const rule = optionalText(ctx.body.rule) ?? "manual";
  await ctx.db.query(`UPDATE inboxes SET status = 'paused' WHERE id = $1`, [id]);
  const created = await pause(ctx.db, { scope: "inbox", target: inbox.rows[0].email, rule, detail, inboxId: id });
  await audit(ctx.db, {
    source: "api",
    actor: ctx.actor,
    action: "inbox.pause",
    entityType: "inboxes",
    entityId: id,
    detail: { rule, created },
  });
  return ok({ paused: true, created });
}

async function resumeOneInbox(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const inbox = await ctx.db.query<{ email: string }>(`SELECT email FROM inboxes WHERE id = $1`, [id]);
  if (!inbox.rows[0]) throw new ApiError(404, "not_found", "inbox not found");
  const resumed = await resumeInbox(ctx.db, { email: inbox.rows[0].email, actor: ctx.actor, source: "api", note: optionalText(ctx.body.note) });
  return ok({ resumed });
}

async function inboxHealth(ctx: Ctx): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  const snapshot = await loadDashboard(ctx.db, parseRange({ from: ctx.search.get("from"), to: ctx.search.get("to") }), {
    queue: { ready: null, processing: null },
  });
  const email = await ctx.db.query<{ email: string }>(`SELECT email FROM inboxes WHERE id = $1`, [id]);
  if (!email.rows[0]) throw new ApiError(404, "not_found", "inbox not found");
  const health = snapshot.health.find((row) => row.email === email.rows[0].email);
  const cap = snapshot.caps.inboxes.find((row) => row.email === email.rows[0].email);
  return ok({ health, cap, unsubSync: snapshot.unsubSync });
}

async function searchMail(ctx: Ctx): Promise<ApiResult> {
  const threads = await listThreads(ctx.db, {
    q: ctx.search.get("q"),
    inboxId: ctx.search.get("inboxId"),
    campaignId: ctx.search.get("campaignId"),
    label: ctx.search.get("label"),
    view: (ctx.search.get("view") as "inbox" | "starred" | "snoozed" | "archive" | "all" | null) ?? "inbox",
  });
  return ok(threads);
}

async function readThread(ctx: Ctx): Promise<ApiResult> {
  const detail = await loadThread(ctx.db, uuid(ctx.params.id, "id"));
  if (!detail) throw new ApiError(404, "not_found", "thread not found");
  return ok(detail);
}

async function composeMail(ctx: Ctx): Promise<ApiResult> {
  return ok(await runCompose(ctx, { mode: "new", sourceMessageId: null }));
}

async function replyMail(ctx: Ctx): Promise<ApiResult> {
  const thread = await loadThread(ctx.db, uuid(ctx.params.id, "id"));
  if (!thread) throw new ApiError(404, "not_found", "thread not found");
  const mode = ctx.body.mode === "reply_all" || ctx.body.mode === "forward" || ctx.body.mode === "reply" ? ctx.body.mode : "reply";
  const source = [...thread.messages].reverse().find((message) => message.direction === "in") ?? thread.messages.at(-1);
  if (!source) throw new ApiError(404, "not_found", "thread has no message");
  return ok(
    await runCompose(ctx, {
      mode,
      sourceMessageId: source.id,
      inboxEmail: thread.inboxEmail,
    }),
  );
}

async function runCompose(
  ctx: Ctx,
  input: { mode: "new" | "reply" | "reply_all" | "forward"; sourceMessageId: string | null; inboxEmail?: string },
): Promise<unknown> {
  const result = await composeManual(ctx.db, {
    inboxEmail: input.inboxEmail ?? text(ctx.body.inboxEmail, "inboxEmail"),
    mode: input.mode,
    sourceMessageId: input.sourceMessageId,
    to: Array.isArray(ctx.body.to) ? ctx.body.to.filter((item): item is string => typeof item === "string") : [],
    cc: Array.isArray(ctx.body.cc) ? ctx.body.cc.filter((item): item is string => typeof item === "string") : [],
    subject: typeof ctx.body.subject === "string" ? ctx.body.subject : "",
    html: typeof ctx.body.html === "string" ? ctx.body.html : "",
    text: typeof ctx.body.text === "string" ? ctx.body.text : null,
    actor: ctx.actor,
    source: "api",
  });
  if (result.outcome === "skipped") throw new ApiError(409, "gate_blocked", result.reason ?? "skipped");
  return { outcome: result.outcome, reason: result.reason ?? null, draftId: result.draftId ?? null };
}

async function threadFlag(ctx: Ctx, action: "archive" | "star" | "read"): Promise<ApiResult> {
  const id = uuid(ctx.params.id, "id");
  if (action === "archive") await setThreadArchived(ctx.db, id, ctx.body.archived !== false, ctx.actor, "api");
  if (action === "star") await setThreadStar(ctx.db, id, ctx.body.starred !== false, ctx.actor, "api");
  if (action === "read") await setThreadRead(ctx.db, id, ctx.body.read !== false, ctx.actor, "api");
  return ok({ ok: true });
}

async function snoozeThread(ctx: Ctx): Promise<ApiResult> {
  const detail = await loadThread(ctx.db, uuid(ctx.params.id, "id"));
  const latest = detail?.messages.at(-1);
  if (!latest) throw new ApiError(404, "not_found", "thread has no message");
  const hours = ctx.body.hours == null ? 24 : numberField(ctx.body.hours, "hours");
  await setMessageState(ctx.db, {
    messageId: latest.id,
    snoozeUntil: new Date(Date.now() + hours * 60 * 60 * 1000),
    actor: ctx.actor,
    source: "api",
  });
  return ok({ ok: true });
}

async function labelThread(ctx: Ctx): Promise<ApiResult> {
  const detail = await loadThread(ctx.db, uuid(ctx.params.id, "id"));
  const latest = detail?.messages.at(-1);
  if (!latest) throw new ApiError(404, "not_found", "thread has no message");
  await applyLabel(ctx.db, { messageId: latest.id, name: text(ctx.body.name, "name"), actor: ctx.actor, source: "api" });
  return ok({ ok: true });
}

async function classifyThread(ctx: Ctx): Promise<ApiResult> {
  const classification = typeof ctx.body.classification === "string" ? ctx.body.classification : "";
  if (!REPLY_CLASSES.includes(classification as ReplyClass)) throw new ApiError(400, "validation", "classification is unknown");
  await relabelMessage(ctx.db, {
    messageId: uuid(text(ctx.body.messageId, "messageId"), "messageId"),
    classification: classification as ReplyClass,
    actor: ctx.actor,
    source: "api",
  });
  return ok({ ok: true });
}

async function noteContact(ctx: Ctx): Promise<ApiResult> {
  await addNote(ctx.db, { contactId: uuid(ctx.params.id, "id"), body: text(ctx.body.body, "body"), actor: ctx.actor, source: "api" });
  return ok({ ok: true }, 201);
}

async function tagContact(ctx: Ctx): Promise<ApiResult> {
  await setTag(ctx.db, {
    contactId: uuid(ctx.params.id, "id"),
    name: text(ctx.body.name, "name"),
    remove: ctx.body.remove === true,
    actor: ctx.actor,
    source: "api",
  });
  return ok({ ok: true });
}

async function saveOneTemplate(ctx: Ctx): Promise<ApiResult> {
  const id = await saveTemplate(ctx.db, {
    name: text(ctx.body.name, "name"),
    subject: optionalText(ctx.body.subject),
    body: text(ctx.body.body, "body"),
    actor: ctx.actor,
    source: "api",
  });
  return ok({ id }, 201);
}

async function dashboardMetrics(ctx: Ctx): Promise<ApiResult> {
  const data = await loadDashboard(ctx.db, parseRange({ from: ctx.search.get("from"), to: ctx.search.get("to") }), {
    queue: { ready: null, processing: null },
  });
  return ok(data);
}

async function dashboardExport(ctx: Ctx): Promise<ApiResult> {
  const view = ctx.search.get("view") ?? "";
  if (!CSV_VIEWS.includes(view as CsvView)) throw new ApiError(400, "validation", "view must be one of the dashboard tables");
  const data = await loadDashboard(ctx.db, parseRange({ from: ctx.search.get("from"), to: ctx.search.get("to") }), {
    queue: { ready: null, processing: null },
  });
  return ok(snapshotCsv(view as CsvView, data), 200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="dashboard-${view}.csv"`,
  });
}

async function listAlerts(ctx: Ctx): Promise<ApiResult> {
  const data = await loadDashboard(ctx.db, parseRange({}), { queue: { ready: null, processing: null } });
  return ok({ ...data.alerts, unsubSync: data.unsubSync });
}

async function createKey(ctx: Ctx): Promise<ApiResult> {
  const role = ctx.body.role === "admin" || ctx.body.role === "operator" || ctx.body.role === "viewer" ? ctx.body.role : null;
  if (!role) throw new ApiError(400, "validation", "role must be admin, operator, or viewer");
  const scopes = Array.isArray(ctx.body.scopes) ? ctx.body.scopes.filter((scope): scope is string => typeof scope === "string") : [];
  const created = await createApiKey(ctx.db, {
    name: text(ctx.body.name, "name"),
    role,
    scopes,
    rateLimitPerMinute: ctx.body.rateLimitPerMinute == null ? undefined : numberField(ctx.body.rateLimitPerMinute, "rateLimitPerMinute"),
  });
  return ok({ secret: created.secret, key: created.record }, 201);
}

async function revokeKey(ctx: Ctx): Promise<ApiResult> {
  const revoked = await revokeApiKey(ctx.db, uuid(ctx.params.id, "id"));
  if (!revoked) throw new ApiError(404, "not_found", "key not found or already revoked");
  return ok({ revoked: true });
}

function numberField(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ApiError(400, "validation", `${field} must be a number`);
  return value;
}
