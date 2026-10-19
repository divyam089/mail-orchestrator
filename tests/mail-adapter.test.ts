import { describe, expect, it } from "vitest";
import { GmailReadOnlyMailbox, MailSendRefused, MockMailAdapter } from "@/lib/mail/adapter";
import type { GmailReadClient } from "@/lib/mail/types";
import { TodoVerificationAdapter } from "@/lib/verify/adapter";

describe("mail adapter", () => {
  it("refuses to send from the mock and from the Gmail mailbox without calling Gmail", async () => {
    const mock = new MockMailAdapter();
    await expect(mock.send({ from: "divyam@usefigcel.com", raw: "unused" })).rejects.toBeInstanceOf(
      MailSendRefused,
    );

    const calls: string[] = [];
    const client: GmailReadClient = {
      async getProfile() {
        calls.push("getProfile");
        return { emailAddress: "divyam@usefigcel.com", historyId: "1" };
      },
      async listMessages() {
        calls.push("listMessages");
        return { messages: [] };
      },
      async getMessage() {
        calls.push("getMessage");
        return null;
      },
      async listHistory() {
        calls.push("listHistory");
        return { expired: true };
      },
    };
    const mailbox = new GmailReadOnlyMailbox(client);
    await expect(mailbox.send({ from: "divyam@usefigcel.com", raw: "unused" })).rejects.toBeInstanceOf(
      MailSendRefused,
    );
    expect(mailbox.provider).toBe("gmail_sa");
    expect(calls).toEqual([]);
    expect(process.env.GMAIL_SA_KEY_PATH ?? "").toBe("");
  });

  it("does not invent a verification vendor", async () => {
    const result = await new TodoVerificationAdapter().verify("person@example.com");
    expect(result.provider).toBe("TODO: verification provider");
    expect(result.status).toBe("unknown");
  });
});
