import { writeDashboardStream } from "@/lib/dashboard/listen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * SSE, not WebSocket. The dashboard is server-to-client only, and this process
 * already speaks HTTP. Postgres LISTEN/NOTIFY wakes the stream when a send,
 * reply, bounce, unsubscribe, draft, pause, or alert commits.
 */
export async function GET(request: Request) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return new Response("DATABASE_URL is not set", { status: 500 });
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort());
  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const write = (chunk: string) => {
    // The dev server holds a small chunk until the response ends. A comment
    // after each frame pushes it past that buffer. EventSource ignores comments.
    const padded = `${chunk}: ${" ".repeat(2048)}\n\n`;
    void writer.write(encoder.encode(padded)).catch(() => abort.abort());
  };
  write(`: connected\n\n`);
  void writeDashboardStream({
    connectionString,
    lastEventId: request.headers.get("last-event-id"),
    signal: abort.signal,
    write,
  })
    .catch(() => abort.abort())
    .finally(() => {
      writer.close().catch(() => undefined);
    });
  abort.signal.addEventListener("abort", () => {
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
