import { Client, Pool } from "pg";

export type DashboardEvent = {
  id: number;
  topic: string;
  entity: string;
  entityId: string | null;
  happenedAt: string;
  op: string;
};

type Hub = {
  pool: Pool;
  listen: Client;
  cursor: number;
  ready: boolean;
  draining: boolean;
  again: boolean;
  subscribers: Set<(event: DashboardEvent) => void>;
};

const globalHubs = globalThis as unknown as { dashboardHubs?: Map<string, Promise<Hub>> };

function hubs(): Map<string, Promise<Hub>> {
  if (!globalHubs.dashboardHubs) globalHubs.dashboardHubs = new Map();
  return globalHubs.dashboardHubs;
}

function mapRow(row: {
  id: string;
  topic: string;
  entity: string;
  entity_id: string | null;
  happened_at: Date;
  payload: { op?: string };
}): DashboardEvent {
  return {
    id: Number(row.id),
    topic: row.topic,
    entity: row.entity,
    entityId: row.entity_id,
    happenedAt: row.happened_at.toISOString(),
    op: row.payload?.op ?? "change",
  };
}

async function drain(hub: Hub): Promise<void> {
  if (!hub.ready) return;
  if (hub.draining) {
    hub.again = true;
    return;
  }
  hub.draining = true;
  try {
    do {
      hub.again = false;
      const rows = await hub.pool.query<{
        id: string;
        topic: string;
        entity: string;
        entity_id: string | null;
        happened_at: Date;
        payload: { op?: string };
      }>(
        `SELECT id::text, topic, entity, entity_id, happened_at, payload
         FROM dashboard_events WHERE id > $1 ORDER BY id`,
        [hub.cursor],
      );
      for (const row of rows.rows) {
        const event = mapRow(row);
        hub.cursor = event.id;
        for (const subscriber of hub.subscribers) subscriber(event);
      }
    } while (hub.again);
  } finally {
    hub.draining = false;
  }
}

async function openHub(connectionString: string): Promise<Hub> {
  const pool = new Pool({ connectionString, max: 2 });
  const listen = new Client({ connectionString });
  const hub: Hub = { pool, listen, cursor: 0, ready: false, draining: false, again: false, subscribers: new Set() };
  listen.on("notification", () => {
    void drain(hub);
  });
  listen.on("error", () => {
    hub.ready = false;
  });
  await listen.connect();
  await listen.query("LISTEN dashboard");
  const max = await pool.query<{ n: string }>("SELECT COALESCE(MAX(id), 0)::text AS n FROM dashboard_events");
  hub.cursor = Number(max.rows[0]?.n ?? 0);
  hub.ready = true;
  return hub;
}

export function dashboardHub(connectionString: string): Promise<Hub> {
  const existing = hubs().get(connectionString);
  if (existing) return existing;
  const created = openHub(connectionString);
  hubs().set(connectionString, created);
  created.catch(() => hubs().delete(connectionString));
  return created;
}

export async function eventsAfter(connectionString: string, id: number): Promise<DashboardEvent[]> {
  const hub = await dashboardHub(connectionString);
  const rows = await hub.pool.query<{
    id: string;
    topic: string;
    entity: string;
    entity_id: string | null;
    happened_at: Date;
    payload: { op?: string };
  }>(
    `SELECT id::text, topic, entity, entity_id, happened_at, payload
     FROM dashboard_events WHERE id > $1 ORDER BY id`,
    [id],
  );
  return rows.rows.map(mapRow);
}

export function formatSse(id: number | string, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * SSE stream. A reconnect with Last-Event-ID replays the missed cursor rows,
 * then live NOTIFY frames. The id field is what the browser sends back.
 */
export async function writeDashboardStream(opts: {
  connectionString: string;
  lastEventId: string | null;
  write: (chunk: string) => void;
  signal: AbortSignal;
  /** When set, a frame is emitted only if this returns a name. The v1 stream uses it. */
  present?: (event: DashboardEvent) => Promise<{ name: string; data: unknown } | null>;
}): Promise<void> {
  const hub = await dashboardHub(opts.connectionString);
  const buffered: DashboardEvent[] = [];
  const onEvent = (event: DashboardEvent) => buffered.push(event);
  hub.subscribers.add(onEvent);
  let last = Number(opts.lastEventId ?? hub.cursor);
  if (!Number.isFinite(last) || last < 0) last = hub.cursor;
  const live = (event: DashboardEvent) => {
    if (event.id <= last) return;
    last = event.id;
    if (!opts.present) {
      opts.write(formatSse(event.id, "change", event));
      return;
    }
    void opts.present(event).then((frame) => {
      if (frame && !opts.signal.aborted) opts.write(formatSse(event.id, frame.name, frame.data));
    });
  };
  try {
    hub.subscribers.add(live);
    const emitPresented = async (event: DashboardEvent) => {
      if (!opts.present) {
        live(event);
        return;
      }
      if (event.id <= last) return;
      last = event.id;
      const frame = await opts.present(event);
      if (frame) opts.write(formatSse(event.id, frame.name, frame.data));
    };
    if (opts.lastEventId != null) {
      const missed = await eventsAfter(opts.connectionString, last);
      for (const event of missed) await emitPresented(event);
    }
    while (buffered.length > 0) {
      const event = buffered.shift();
      if (event) await emitPresented(event);
    }
    hub.subscribers.delete(onEvent);
    opts.write(formatSse(last, "ready", { after: last }));
    await new Promise<void>((resolve) => {
      const keepalive = setInterval(() => {
        if (!opts.signal.aborted) opts.write(`: keepalive\n\n`);
      }, 15000);
      const finish = () => {
        clearInterval(keepalive);
        hub.subscribers.delete(live);
        resolve();
      };
      if (opts.signal.aborted) {
        finish();
        return;
      }
      opts.signal.addEventListener("abort", finish, { once: true });
    });
  } finally {
    hub.subscribers.delete(onEvent);
    hub.subscribers.delete(live);
  }
}

export async function stopDashboardHubs(): Promise<void> {
  const open = [...hubs().values()];
  hubs().clear();
  for (const pending of open) {
    const hub = await pending.catch(() => null);
    if (!hub) continue;
    hub.subscribers.clear();
    await hub.listen.end().catch(() => undefined);
    await hub.pool.end().catch(() => undefined);
  }
}
