import { config } from "dotenv";
import { migrate } from "@/lib/db/migrate";
import { getPool } from "@/lib/db/pool";
import { seed } from "@/lib/db/seed";
import { serviceAccountClientFactory } from "@/lib/mail/gmail-sa";
import { GMAIL_SYNC_LIMIT_DEFAULT, assertSyncLimit } from "@/lib/mail/quota";
import { syncInbox } from "@/lib/mail/sync";
import { flag, parseArgs } from "./cli-args";

config({ quiet: true });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inbox = flag(args, "inbox");
  if (!inbox) {
    throw new Error("Pass --inbox <email>. Example: npm run inbox:sync -- --inbox divyam@usefigcel.com --limit 50");
  }
  const limit = Number(flag(args, "limit") ?? GMAIL_SYNC_LIMIT_DEFAULT);
  assertSyncLimit(limit);
  await migrate();
  const pool = getPool();
  await seed(pool);
  const factory = await serviceAccountClientFactory();
  const client = await factory(inbox);
  const result = await syncInbox(pool, inbox, client, { limit });
  await pool.end();
  if (!result.ok) {
    console.error(`${result.email}  disconnected  ${result.error}`);
    process.exit(1);
  }
  console.log(
    `${result.email}  active  mode=${result.mode}  stored=${result.stored}  removed=${result.removed}  historyId=${result.historyId}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
