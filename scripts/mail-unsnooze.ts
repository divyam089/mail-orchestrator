import { config } from "dotenv";
import { migrate } from "@/lib/db/migrate";
import { getPool } from "@/lib/db/pool";
import { releaseSnoozed } from "@/lib/mail/mailbox";

config({ quiet: true });

async function main() {
  await migrate();
  const pool = getPool();
  const released = await releaseSnoozed(pool);
  console.log(`unsnoozed ${released}`);
  await pool.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
