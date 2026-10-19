import { config } from "dotenv";
import { INBOXES } from "@/lib/inboxes";
import { migrate } from "@/lib/db/migrate";
import { getPool } from "@/lib/db/pool";
import { seed } from "@/lib/db/seed";
import { serviceAccountClientFactory } from "@/lib/mail/gmail-sa";
import { GMAIL_SYNC_LIMIT_DEFAULT, assertSyncLimit } from "@/lib/mail/quota";
import { DEFAULT_SYNC_INTERVAL_MS, MIN_SYNC_INTERVAL_MS, runScheduledSync } from "@/lib/mail/schedule";
import { flag, parseArgs } from "./cli-args";

config({ quiet: true });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(flag(args, "limit") ?? GMAIL_SYNC_LIMIT_DEFAULT);
  assertSyncLimit(limit);
  const seconds = Number(flag(args, "interval") ?? String(DEFAULT_SYNC_INTERVAL_MS / 1000));
  if (!Number.isInteger(seconds) || seconds * 1000 < MIN_SYNC_INTERVAL_MS) {
    throw new Error("--interval is seconds, minimum 60. Default is 300.");
  }
  const only = flag(args, "inbox");
  const inboxes = only ? [only] : INBOXES.map((inbox) => inbox.email);
  await migrate();
  const pool = getPool();
  await seed(pool);
  const factory = await serviceAccountClientFactory();
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  console.log(`Scheduled read-only sync every ${seconds}s for ${inboxes.length} inbox(es). Ctrl-C stops it.`);
  await runScheduledSync({
    db: pool,
    clientFor: factory,
    limit,
    intervalMs: seconds * 1000,
    inboxes,
    signal: controller.signal,
  });
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
