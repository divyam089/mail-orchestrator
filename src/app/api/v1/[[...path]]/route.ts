import { buildOpenApi } from "@/lib/api/openapi";
import { presentApiEvent } from "@/lib/api/events";
import { handleApiV1, toApiResult, type ApiCall } from "@/lib/api/handle";
import { authenticateApiKey } from "@/lib/api/keys";
import { takeRateToken } from "@/lib/api/rate";
import { getPool } from "@/lib/db/pool";
import { writeDashboardStream } from "@/lib/dashboard/listen";
import { audit } from "@/lib/send/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function pathOf(context: { params: Promise<{ path?: string[] }> }): Promise<string> {
  const { path } = await context.params;
  return `/${(path ?? []).join("/")}`;
}

async function call(method: string, path: string, request: Request): Promise<Response> {
  let body: unknown = {};
  if (method !== "GET" && method !== "DELETE") {
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        return Response.json({ error: { code: "validation", message: "Body must be JSON" } }, { status: 400 });
      }
    }
  }
  const url = new URL(request.url);
  const input: ApiCall = { method, path, headers: request.headers, body, search: url.searchParams };
  try {
    const result = await handleApiV1(getPool(), input);
    if (typeof result.body === "string") {
      return new Response(result.body, { status: result.status, headers: result.headers });
    }
    return Response.json(result.body, { status: result.status });
  } catch (error) {
    const result = toApiResult(error);
    return Response.json(result.body, { status: result.status });
  }
}

async function events(request: Request): Promise<Response> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return Response.json({ error: { code: "internal", message: "DATABASE_URL is not set" } }, { status: 500 });
  }
  try {
    const key = await authenticateApiKey(getPool(), request.headers.get("authorization"));
    if (!takeRateToken(key.id, key.rateLimitPerMinute)) {
      return Response.json({ error: { code: "rate_limited", message: "Rate limit" } }, { status: 429 });
    }
    if (key.scopes.length > 0 && !key.scopes.includes("events.read")) {
      return Response.json({ error: { code: "forbidden", message: "events.read is not on this key" } }, { status: 403 });
    }
    await audit(getPool(), {
      source: "api",
      actor: `api:${key.name}`,
      action: "events.stream",
      entityType: "api",
      entityId: key.id,
      detail: { path: "/events" },
    });
  } catch (error) {
    const result = toApiResult(error);
    return Response.json(result.body, { status: result.status });
  }
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const write = (chunk: string) => {
    const padded = `${chunk}: ${" ".repeat(2048)}\n\n`;
    void writer.write(encoder.encode(padded)).catch(() => abort.abort());
  };
  write(`: connected\n\n`);
  void writeDashboardStream({
    connectionString,
    lastEventId: request.headers.get("last-event-id"),
    signal: abort.signal,
    write,
    present: (event) => presentApiEvent(getPool(), event),
  })
    .catch(() => abort.abort())
    .finally(() => {
      writer.close().catch(() => undefined);
    });
  return new Response(stream.readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "content-encoding": "none",
      "x-accel-buffering": "no",
    },
  });
}

export async function GET(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  const path = await pathOf(context);
  if (path === "/openapi.json") return Response.json(buildOpenApi());
  if (path === "/events") return events(request);
  return call("GET", path, request);
}

export async function POST(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return call("POST", await pathOf(context), request);
}

export async function PATCH(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return call("PATCH", await pathOf(context), request);
}

export async function DELETE(request: Request, context: { params: Promise<{ path?: string[] }> }) {
  return call("DELETE", await pathOf(context), request);
}
