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

/** Used by every test and by this step's runtime. It cannot deliver mail. */
export class MockMailAdapter implements MailAdapter {
  readonly provider = "mock" as const;

  async send(message: OutboundMessage): Promise<{ id: string; threadId: string }> {
    throw new MailSendRefused(
      `Mock mail adapter refused to send from ${message.from}. Development and tests never send real email.`,
    );
  }
}

/**
 * Gmail API via one service account and domain-wide delegation.
 * Step 2 implements this. The key path will be env GMAIL_SA_KEY_PATH only.
 * Scopes: gmail.send, gmail.readonly, gmail.modify. Impersonate each inbox.
 * Project figcel-sender, service account coldsend, five Workspace tenants.
 * Calling this in step 1 always refuses, even if a key path is set.
 */
export function gmailServiceAccountAdapter(): MailAdapter {
  throw new MailSendRefused(
    "Gmail service-account adapter is not enabled in this build. No real email is sent.",
  );
}
