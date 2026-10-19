import { UI_ACTIONS } from "@/lib/api/actions";
import { API_ERROR_CODES } from "@/lib/api/errors";

export function buildOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const action of UI_ACTIONS) {
    const item = paths[action.path] ?? {};
    item[action.method.toLowerCase()] = {
      operationId: action.id,
      summary: action.summary,
      tags: [action.ui],
      security: [{ bearer: [] }],
      responses: {
        "200": { description: action.summary },
        "400": { description: "Validation or a missing Idempotency-Key", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        "401": { description: "Missing or revoked key" },
        "403": { description: "Role or scope does not allow this action" },
        "409": { description: "Gate blocked the action, or the idempotency key was reused with a different body" },
        "429": { description: "Per-key rate limit" },
      },
      "x-role": action.role,
      "x-scope": action.scope,
      "x-idempotency": action.idempotent,
    };
    paths[action.path] = item;
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Figcel Outreach API",
      version: "1.0.0",
      description:
        "The same actions as the UI. API sends use the approval toggle, caps, ramp, send window, suppression, stop rules, and the SENDING_ENABLED kill switch. A key cannot turn sending on.",
    },
    servers: [{ url: "/api/v1" }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "API key created in the admin desk. Stored as a SHA-256 hash." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: {
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: [...API_ERROR_CODES] },
                message: { type: "string" },
              },
            },
          },
        },
      },
    },
    paths,
  };
}
