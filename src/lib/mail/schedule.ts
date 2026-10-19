import { INBOXES } from "@/lib/inboxes";
import type { Db } from "@/lib/db/pool";
import { syncInbox, type SyncResult } from "@/lib/mail/sync";
import type { GmailReadClient } from "@/lib/mail/types";

export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const MIN_SYNC_INTERVAL_MS = 60 * 1000;

export type ScheduledSyncOptions = {
  db: Db;
  clientFor: (inboxEmail: string) => Promise<GmailReadClient>;
  limit: number;
  intervalMs?: number;
  inboxes?: readonly string[];
  iterations?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Sequential sync of the roster. One inbox at a time, so a single user is not
 * hit with parallel requests (Gmail returns 429 for too many concurrent
 * requests per user). The web server does not start this loop.
 */
export async function runScheduledSync(opts: ScheduledSyncOptions): Promise<{ ticks: number; results: SyncResult[] }> {
  const intervalMs = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  if (intervalMs < MIN_SYNC_INTERVAL_MS) {
    throw new Error(`Sync interval must be at least ${MIN_SYNC_INTERVAL_MS}ms`);
  }
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inboxes = opts.inboxes ?? INBOXES.map((inbox) => inbox.email);
  const results: SyncResult[] = [];
  let ticks = 0;
  while (!opts.signal?.aborted && (opts.iterations == null || ticks < opts.iterations)) {
    for (const email of inboxes) {
      if (opts.signal?.aborted) break;
      const client = await opts.clientFor(email);
      results.push(await syncInbox(opts.db, email, client, { limit: opts.limit }));
    }
    ticks += 1;
    if (opts.iterations != null && ticks >= opts.iterations) break;
    if (opts.signal?.aborted) break;
    await sleep(intervalMs);
  }
  return { ticks, results };
}
