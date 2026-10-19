import { readFileSync } from "node:fs";
import { getPool } from "@/lib/db/pool";
import { readSendMode } from "@/lib/gates";
import { GmailSendMailbox } from "@/lib/mail/gmail-send";
import { requireServiceAccountKeyPath } from "@/lib/mail/key-path";
import { GMAIL_SCOPES } from "@/lib/mail/quota";
import { createRedis } from "@/lib/redis";
import { RedisSendQueue } from "@/lib/send/queue";
import { drainQueue } from "@/lib/send/worker";

/**
 * Started only from scripts/send-worker.ts after SENDING_ENABLED is exactly true.
 * The web server does not import this module.
 */
export async function startGmailWorker(): Promise<void> {
  const keyPath = requireServiceAccountKeyPath();
  const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account JSON is missing client_email or private_key");
  }
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  const { JWT } = await import("google-auth-library");
  const redis = createRedis();
  const queue = new RedisSendQueue(redis);
  await queue.requeueInflight();
  const pool = getPool();
  const mailboxFor = (inboxEmail: string) => {
    const jwt = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: [...GMAIL_SCOPES],
      subject: inboxEmail,
    });
    return new GmailSendMailbox(async () => {
      const token = await jwt.getAccessToken();
      if (!token.token) throw new Error(`Google auth returned no access token for ${inboxEmail}`);
      return token.token;
    });
  };
  const adapter = {
    provider: "gmail_sa" as const,
    send: async (message: { from: string; raw: string; threadId?: string; to?: string }) =>
      mailboxFor(message.from).send(message),
  };
  const results = await drainQueue(pool, queue, {
    adapter,
    sendingEnabled: true,
    sendMode: readSendMode(),
    limit: 15,
  });
  console.log(`Send worker finished ${results.length} job(s).`);
  redis.disconnect();
}
