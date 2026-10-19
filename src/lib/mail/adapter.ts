import type { GmailReadClient } from "@/lib/mail/types";

export type MailProvider = "gmail_sa" | "gmail_oauth" | "imap_smtp" | "mock";

export class MailSendRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailSendRefused";
  }
}

export type OutboundMessage = {
  from: string;
  raw: string;
  threadId?: string;
};

export interface MailAdapter {
  readonly provider: MailProvider;
  send(message: OutboundMessage): Promise<{ id: string; threadId: string }>;
}

/** Used by every test. It cannot deliver mail. */
export class MockMailAdapter implements MailAdapter {
  readonly provider = "mock" as const;

  async send(message: OutboundMessage): Promise<{ id: string; threadId: string }> {
    throw new MailSendRefused(
      `Mock mail adapter refused to send from ${message.from}. Development and tests never send real email.`,
    );
  }
}

/**
 * Service-account mailbox. Read methods live on GmailReadClient.
 * send() throws before any network call. Sync does not use this method.
 */
export class GmailReadOnlyMailbox implements MailAdapter {
  readonly provider = "gmail_sa" as const;

  constructor(readonly client: GmailReadClient) {}

  async send(message: OutboundMessage): Promise<{ id: string; threadId: string }> {
    throw new MailSendRefused(
      `Gmail adapter refused to send from ${message.from}. This step is read-only and sending is disabled.`,
    );
  }
}
