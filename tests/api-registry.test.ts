import { expect, it } from "vitest";
import { UI_ACTIONS, findAction } from "@/lib/api/actions";
import { apiHandlers } from "@/lib/api/handle";
import { buildOpenApi } from "@/lib/api/openapi";

const REQUIRED = [
  "campaigns.list",
  "campaigns.create",
  "campaigns.read",
  "campaigns.update",
  "campaigns.archive",
  "steps.create",
  "steps.update",
  "steps.delete",
  "variants.create",
  "variants.update",
  "variants.delete",
  "imports.create",
  "imports.read",
  "verification.read",
  "holds.list",
  "holds.decide",
  "suppression.list",
  "suppression.add",
  "approval.set",
  "review.list",
  "review.approve",
  "review.edit",
  "review.reject",
  "review.bulk",
  "inboxes.list",
  "inboxes.pause",
  "inboxes.resume",
  "inboxes.health",
  "mail.search",
  "mail.thread",
  "mail.compose",
  "mail.reply",
  "mail.archive",
  "mail.star",
  "mail.read",
  "mail.snooze",
  "mail.label",
  "mail.classify",
  "mail.note",
  "mail.tag",
  "templates.list",
  "templates.save",
  "dashboard.metrics",
  "dashboard.export",
  "alerts.list",
  "events.stream",
  "keys.list",
  "keys.create",
  "keys.revoke",
];

it("fails when a UI action has no API handler or OpenAPI operation", () => {
  const handlers = apiHandlers();
  const spec = buildOpenApi() as {
    openapi: string;
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
  expect(spec.openapi).toBe("3.1.0");
  for (const id of REQUIRED) {
    expect(UI_ACTIONS.some((action) => action.id === id), id).toBe(true);
  }
  for (const action of UI_ACTIONS) {
    expect(typeof handlers[action.id], action.id).toBe("function");
    expect(spec.paths[action.path]?.[action.method.toLowerCase()]?.operationId).toBe(action.id);
    expect(findAction(action.method, action.path.replace(/\{[^}]+\}/g, "11111111-1111-1111-1111-111111111111"))?.action.id).toBe(action.id);
  }
});
