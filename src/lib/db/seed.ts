import { INBOXES, domainOf } from "@/lib/inboxes";
import { getPool, type Db } from "@/lib/db/pool";

export async function seed(db: Db = getPool()): Promise<void> {
  const domains = [...new Set(INBOXES.map((inbox) => domainOf(inbox.email)))];
  for (const domain of domains) {
    await db.query("INSERT INTO sending_domains (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING", [
      domain,
    ]);
  }
  for (const inbox of INBOXES) {
    await db.query(
      `INSERT INTO inboxes (email, sender_name, domain, provider)
       VALUES ($1, $2, $3, 'gmail_sa')
       ON CONFLICT (email) DO UPDATE
         SET sender_name = EXCLUDED.sender_name,
             domain = EXCLUDED.domain`,
      [inbox.email, inbox.senderName, domainOf(inbox.email)],
    );
  }
  await db.query("INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
}
