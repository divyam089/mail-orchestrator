import type { MailAdapter } from "@/lib/mail/adapter";
import type { Db } from "@/lib/db/pool";
import { executeSend, type ExecuteResult } from "@/lib/send/execute";
import type { SendQueue } from "@/lib/send/queue";
import type { Rng } from "@/lib/send/template";

/** Claims queued jobs. A throw leaves the job on the processing list for restart. */
export async function drainQueue(
  db: Db,
  queue: SendQueue,
  opts: {
    adapter: MailAdapter;
    now?: Date;
    sendingEnabled?: boolean;
    sendMode?: "dry-run" | "seed-only" | "live";
    holidays?: readonly string[];
    rng?: Rng;
    hooks?: { afterReserve?: () => Promise<void> | void; afterAdapter?: () => Promise<void> | void };
    limit?: number;
  },
): Promise<ExecuteResult[]> {
  const results: ExecuteResult[] = [];
  const limit = opts.limit ?? 50;
  for (let i = 0; i < limit; i++) {
    const claimed = await queue.claim();
    if (!claimed) break;
    const result = await executeSend(db, claimed.job, opts);
    if (result.outcome === "deferred") await queue.release(claimed.raw);
    else await queue.ack(claimed.raw);
    results.push(result);
  }
  return results;
}
