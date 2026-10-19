import type { Db } from "@/lib/db/pool";

export type MirrorAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "unarchive"
  | "snooze"
  | "unsnooze"
  | "label_add"
  | "label_remove";

export function readMirrorEnabled(env?: { GMAIL_MIRROR_ENABLED?: string }): boolean {
  const source = env ?? process.env;
  return (source.GMAIL_MIRROR_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export type MirrorFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * messages.modify. Sync never imports this. applyMirror calls it only when the flag is on.
 */
export async function postGmailModify(opts: {
  getToken: () => Promise<string>;
  gmailMessageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
  fetchImpl: MirrorFetch;
}): Promise<void> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(opts.gmailMessageId)}/modify`;
  const response = await opts.fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await opts.getToken()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      addLabelIds: opts.addLabelIds ?? [],
      removeLabelIds: opts.removeLabelIds ?? [],
    }),
  });
  if (response.status < 200 || response.status >= 300) {
    const text = await response.text();
    throw new Error(`Gmail modify failed with HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

export async function recordMirror(
  db: Db,
  input: { inboxId: string; gmailMessageId: string; action: MirrorAction; payload?: unknown },
): Promise<void> {
  const enabled = readMirrorEnabled();
  await db.query(
    `INSERT INTO gmail_mirror_jobs (inbox_id, gmail_message_id, action, payload, held_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5)`,
    [
      input.inboxId,
      input.gmailMessageId,
      input.action,
      JSON.stringify(input.payload ?? {}),
      enabled ? null : "GMAIL_MIRROR_ENABLED is not true",
    ],
  );
}

/** Applies pending jobs only when the flag is exactly true. Otherwise it does not call fetch. */
export async function applyMirror(
  db: Db,
  opts: { getToken: () => Promise<string>; fetchImpl: MirrorFetch; enabled?: boolean },
): Promise<{ applied: number; held: number }> {
  const enabled = opts.enabled ?? readMirrorEnabled();
  const pending = await db.query<{ id: string; n: string }>(
    "SELECT COUNT(*)::text AS n FROM gmail_mirror_jobs WHERE applied_at IS NULL",
  );
  const held = Number(pending.rows[0]?.n ?? 0);
  if (!enabled) return { applied: 0, held };
  const jobs = await db.query<{
    id: string;
    gmail_message_id: string;
    action: MirrorAction;
    payload: { add?: string[]; remove?: string[] };
  }>("SELECT id, gmail_message_id, action, payload FROM gmail_mirror_jobs WHERE applied_at IS NULL ORDER BY created_at");
  let applied = 0;
  for (const job of jobs.rows) {
    const labels = labelsFor(job.action, job.payload);
    await postGmailModify({
      getToken: opts.getToken,
      gmailMessageId: job.gmail_message_id,
      addLabelIds: labels.add,
      removeLabelIds: labels.remove,
      fetchImpl: opts.fetchImpl,
    });
    await db.query("UPDATE gmail_mirror_jobs SET applied_at = now(), held_reason = NULL WHERE id = $1", [job.id]);
    applied += 1;
  }
  return { applied, held: 0 };
}

function labelsFor(action: MirrorAction, payload: { add?: string[]; remove?: string[] } | null): { add: string[]; remove: string[] } {
  switch (action) {
    case "read":
      return { add: [], remove: ["UNREAD"] };
    case "unread":
      return { add: ["UNREAD"], remove: [] };
    case "star":
      return { add: ["STARRED"], remove: [] };
    case "unstar":
      return { add: [], remove: ["STARRED"] };
    case "archive":
      return { add: [], remove: ["INBOX"] };
    case "unarchive":
      return { add: ["INBOX"], remove: [] };
    case "label_add":
      return { add: payload?.add ?? [], remove: [] };
    case "label_remove":
      return { add: [], remove: payload?.remove ?? [] };
    default:
      return { add: [], remove: [] };
  }
}
