import { config } from "dotenv";
import { INBOXES } from "@/lib/inboxes";
import { migrate } from "@/lib/db/migrate";
import { getPool } from "@/lib/db/pool";
import { seed } from "@/lib/db/seed";
import { serviceAccountClientFactory } from "@/lib/mail/gmail-sa";
import { connectInbox } from "@/lib/mail/sync";
import { flag, parseArgs } from "./cli-args";

config({ quiet: true });

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const only = flag(args, "inbox");
  const targets = only ? [only] : INBOXES.map((inbox) => inbox.email);
  await migrate();
  const pool = getPool();
  await seed(pool);
  const factory = await serviceAccountClientFactory();
  let failed = 0;
  for (const email of targets) {
    const client = await factory(email);
    const result = await connectInbox(pool, email, client);
    if (result.ok) {
      console.log(`${result.email}  active  historyId=${result.historyId}  messagesTotal=${result.messagesTotal ?? "unknown"}`);
    } else {
      failed += 1;
      console.error(`${result.email}  disconnected  ${result.error}`);
    }
  }
  await pool.end();
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
