import type { MailAdapter, OutboundMessage } from "@/lib/mail/adapter";
import { MailSendRefused } from "@/lib/mail/adapter";

export type GmailSendFetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text(): Promise<string> }>;

const SEND_PATH = "/gmail/v1/users/me/messages/send";

/**
 * POST messages.send. This module is not imported by the read client or by sync.
 * Callers must already have passed deliverBehindGates. The read-only guard still
 * rejects this path if it is ever handed to the sync client.
 */
export async function postGmailSend(opts: {
  getToken: () => Promise<string>;
  raw: string;
  threadId?: string;
  fetchImpl?: GmailSendFetch;
}): Promise<{ id: string; threadId: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `https://gmail.googleapis.com${SEND_PATH}`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await opts.getToken()}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ raw: opts.raw, threadId: opts.threadId }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as { id?: string; threadId?: string; error?: { message?: string } }) : {};
  if (response.status < 200 || response.status >= 300 || !body.id) {
    throw new Error(body.error?.message ?? `Gmail send failed with HTTP ${response.status}`);
  }
  return { id: body.id, threadId: body.threadId ?? body.id };
}

export class GmailSendMailbox implements MailAdapter {
  readonly provider = "gmail_sa" as const;

  constructor(private readonly getToken: () => Promise<string>, private readonly fetchImpl?: GmailSendFetch) {}

  async send(message: OutboundMessage): Promise<{ id: string; threadId: string }> {
    if (!message.raw) throw new MailSendRefused("Gmail send refused an empty message");
    return postGmailSend({
      getToken: this.getToken,
      raw: message.raw,
      threadId: message.threadId,
      fetchImpl: this.fetchImpl,
    });
  }
}
