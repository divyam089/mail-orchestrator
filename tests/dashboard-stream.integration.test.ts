import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { stopDashboardHubs, writeDashboardStream } from "@/lib/dashboard/listen";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });

type Frame = { id: string; event: string; data: { entityId?: string | null } };

class SseReader {
  frames: Frame[] = [];
  private buf = "";
  constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) {}

  async until(pred: (frames: Frame[]) => boolean, timeoutMs: number): Promise<Frame[]> {
    const deadline = Date.now() + timeoutMs;
    while (!pred(this.frames)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const next = await Promise.race([
        this.reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (next === null || next.done) break;
      this.buf += new TextDecoder().decode(next.value);
      this.consume();
    }
    return this.frames;
  }

  private consume() {
    const parts = this.buf.split("\n\n");
    this.buf = parts.pop() ?? "";
    for (const part of parts) {
      const lines = part.split("\n");
      if (lines.every((line) => line.startsWith(":") || line.trim() === "")) continue;
      const dataLine = lines.find((line) => line.startsWith("data: "));
      this.frames.push({
        id: lines.find((line) => line.startsWith("id: "))?.slice(4) ?? "",
        event: lines.find((line) => line.startsWith("event: "))?.slice(7) ?? "",
        data: dataLine ? (JSON.parse(dataLine.slice(6)) as Frame["data"]) : {},
      });
    }
  }
}

let server: http.Server;
let port = 0;
const controllers: AbortController[] = [];

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
  server = http.createServer((req, res) => {
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const header = req.headers["last-event-id"];
    void writeDashboardStream({
      connectionString,
      lastEventId: typeof header === "string" ? header : null,
      signal: abort.signal,
      write(chunk) {
        if (!res.writableEnded) res.write(chunk);
      },
    })
      .catch(() => undefined)
      .finally(() => {
        if (!res.writableEnded) res.end();
      });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      port = typeof address === "object" && address ? address.port : 0;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const controller of controllers) controller.abort();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  await stopDashboardHubs();
  await pool.end();
});

async function insertReply(token: string): Promise<{ eventId: string; cursorId: number }> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO events (kind, detail, occurred_at, et_date)
     VALUES ('reply', $1::jsonb, now(), '2026-10-19')
     RETURNING id`,
    [JSON.stringify({ probe: token })],
  );
  const eventId = inserted.rows[0].id;
  const cursor = await pool.query<{ id: string }>(
    `SELECT id::text FROM dashboard_events WHERE entity = 'events' AND entity_id = $1`,
    [eventId],
  );
  return { eventId, cursorId: Number(cursor.rows[0].id) };
}

async function cleanup(eventIds: string[]) {
  if (eventIds.length === 0) return;
  await pool.query(`DELETE FROM dashboard_events WHERE entity = 'events' AND entity_id = ANY($1::text[])`, [eventIds]);
  await pool.query(`DELETE FROM events WHERE id = ANY($1::uuid[])`, [eventIds]);
}

async function openStream(headers?: Record<string, string>) {
  const controller = new AbortController();
  controllers.push(controller);
  const response = await fetch(`http://127.0.0.1:${port}/stream`, { headers, signal: controller.signal });
  if (!response.body) throw new Error("SSE response has no body");
  return { controller, reader: new SseReader(response.body.getReader()) };
}

describe.sequential("dashboard SSE", () => {
  it("delivers a committed reply to the stream in under 1.5s", async () => {
    const ids: string[] = [];
    const { reader, controller } = await openStream();
    try {
      const ready = await reader.until((frames) => frames.some((frame) => frame.event === "ready"), 4000);
      expect(ready.some((frame) => frame.event === "ready")).toBe(true);
      const token = `latency-${Date.now()}`;
      const started = performance.now();
      const probe = await insertReply(token);
      ids.push(probe.eventId);
      const frames = await reader.until(
        (list) => list.some((frame) => frame.event === "change" && frame.data.entityId === probe.eventId),
        1500,
      );
      const elapsed = performance.now() - started;
      console.log(`dashboard latency ${elapsed.toFixed(1)}ms`);
      expect(frames.some((frame) => frame.event === "change" && frame.data.entityId === probe.eventId)).toBe(true);
      expect(elapsed).toBeLessThan(1500);
    } finally {
      controller.abort();
      await cleanup(ids);
    }
  }, 15000);

  it("replays events after Last-Event-ID and then stays live", async () => {
    const ids: string[] = [];
    const token = `backfill-${Date.now()}`;
    try {
      const first = await insertReply(`${token}-a`);
      const second = await insertReply(`${token}-b`);
      ids.push(first.eventId, second.eventId);
      const started = performance.now();
      const { reader, controller } = await openStream({ "last-event-id": String(first.cursorId) });
      try {
        const replay = await reader.until(
          (frames) => frames.some((frame) => frame.data.entityId === second.eventId),
          1500,
        );
        const replayed = performance.now() - started;
        console.log(`dashboard backfill ${replayed.toFixed(1)}ms`);
        expect(replayed).toBeLessThan(1500);
        expect(replay.some((frame) => frame.data.entityId === second.eventId)).toBe(true);
        expect(replay.some((frame) => frame.data.entityId === first.eventId)).toBe(false);
        const liveAt = performance.now();
        const third = await insertReply(`${token}-c`);
        ids.push(third.eventId);
        const live = await reader.until((frames) => frames.some((frame) => frame.data.entityId === third.eventId), 1500);
        const lived = performance.now() - liveAt;
        console.log(`dashboard live-after-backfill ${lived.toFixed(1)}ms`);
        expect(lived).toBeLessThan(1500);
        expect(live.some((frame) => frame.event === "change" && frame.data.entityId === third.eventId)).toBe(true);
      } finally {
        controller.abort();
      }
    } finally {
      await cleanup(ids);
    }
  }, 15000);
});
