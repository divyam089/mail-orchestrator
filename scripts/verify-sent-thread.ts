/**
 * Seed-only check that a manual reply lands in that inbox's Gmail Sent folder,
 * in the same thread. Do not run this unless you mean to send one message to
 * a seed address.
 *
 * Refuses, and does not import the Gmail sender, unless every guard holds:
 *   SEND_MODE=seed-only
 *   SENDING_ENABLED=true
 *   --confirm-seed-send
 *   --inbox <inbox email>
 *   --seed <address already in seed_addresses>
 *   --thread <threads.id>
 * Approval must be auto for that one check, or the reply stays a Review draft.
 *
 *   SEND_MODE=seed-only SENDING_ENABLED=true \
 *     npm run mail:verify-sent -- --confirm-seed-send \
 *     --inbox divyam@usefigcel.com --seed you@yourseed.com --thread <uuid>
 *
 * Then open Gmail as that inbox and confirm the reply is in Sent, on the same thread.
 * Set approval back to review and SENDING_ENABLED back to false when you are done.
 */
import { config } from "dotenv";
import { flag, parseArgs } from "./cli-args";

config({ quiet: true });

function refuse(reason: string): never {
  console.error(`verify-sent-thread refused: ${reason}`);
  console.error("No Gmail request was made.");
  process.exit(2);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inboxEmail = flag(args, "inbox");
  const seedEmail = flag(args, "seed");
  const threadId = flag(args, "thread");
  const confirmed = args.get("confirm-seed-send") === true;
  const sendMode = (process.env.SEND_MODE ?? "dry-run").trim();
  const sendingEnabled = (process.env.SENDING_ENABLED ?? "false").trim().toLowerCase() === "true";

  if (!confirmed) refuse("pass --confirm-seed-send");
  if (sendMode !== "seed-only") refuse(`SEND_MODE is ${sendMode}, not seed-only`);
  if (!sendingEnabled) refuse("SENDING_ENABLED is not true");
  if (!inboxEmail || !seedEmail || !threadId) refuse("--inbox, --seed, and --thread are required");

  const { migrate } = await import("@/lib/db/migrate");
  const { getPool } = await import("@/lib/db/pool");
  const { loadSendSettings } = await import("@/lib/send/settings");
  await migrate();
  const pool = getPool();
  const settings = await loadSendSettings(pool);
  if (settings.approvalMode !== "auto") {
    await pool.end();
    refuse("approval is off, so this reply would stay a Review draft");
  }
  const seed = await pool.query("SELECT 1 FROM seed_addresses WHERE email = $1", [seedEmail.trim().toLowerCase()]);
  if (seed.rows.length === 0) {
    await pool.end();
    refuse(`${seedEmail} is not in seed_addresses`);
  }
  const thread = await pool.query<{ id: string; inbox_email: string; message_id: string }>(
    `SELECT t.id, i.email AS inbox_email, m.id AS message_id
     FROM threads t
     JOIN inboxes i ON i.id = t.inbox_id
     JOIN messages m ON m.thread_row_id = t.id
     WHERE t.id = $1
     ORDER BY m.internal_date DESC NULLS LAST
     LIMIT 1`,
    [threadId],
  );
  const row = thread.rows[0];
  if (!row) {
    await pool.end();
    refuse("thread not found");
  }
  if (row.inbox_email !== inboxEmail.trim().toLowerCase()) {
    await pool.end();
    refuse(`that thread belongs to ${row.inbox_email}, not ${inboxEmail}`);
  }

  const { readFileSync } = await import("node:fs");
  const { JWT } = await import("google-auth-library");
  const { requireServiceAccountKeyPath } = await import("@/lib/mail/key-path");
  const { GMAIL_SCOPES } = await import("@/lib/mail/quota");
  const { GmailSendMailbox } = await import("@/lib/mail/gmail-send");
  const { composeManual } = await import("@/lib/mail/compose");

  const keyPath = requireServiceAccountKeyPath();
  const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) {
    await pool.end();
    refuse("service account JSON is missing client_email or private_key");
  }
  const jwt = new JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: [...GMAIL_SCOPES],
    subject: row.inbox_email,
  });
  const adapter = new GmailSendMailbox(async () => {
    const token = await jwt.getAccessToken();
    if (!token.token) throw new Error(`no access token for ${row.inbox_email}`);
    return token.token;
  });

  const result = await composeManual(pool, {
    inboxEmail: row.inbox_email,
    mode: "reply",
    sourceMessageId: row.message_id,
    to: [seedEmail.trim().toLowerCase()],
    subject: "",
    html: "<p>Seed check. Confirm this reply is in Sent on the same thread.</p>",
    actor: "operator",
    source: "system",
    sendingEnabled: true,
    sendMode: "seed-only",
    adapter,
  });
  console.log(JSON.stringify({ outcome: result.outcome, reason: result.reason, draftId: result.draftId }));
  if (result.outcome === "sent") {
    console.log(`Open Gmail as ${row.inbox_email}. The reply should be in Sent, on thread ${threadId}.`);
  }
  await pool.end();
  if (result.outcome !== "sent") process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
