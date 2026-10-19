import { describe, expect, it } from "vitest";
import { MailSendRefused, MockMailAdapter, gmailServiceAccountAdapter } from "@/lib/mail/adapter";
import { TodoVerificationAdapter } from "@/lib/verify/adapter";

describe("mail adapter", () => {
  it("refuses to send from the mock and from the unbuilt Gmail adapter", async () => {
    const mock = new MockMailAdapter();
    await expect(mock.send({ from: "divyam@usefigcel.com", raw: "unused" })).rejects.toBeInstanceOf(
      MailSendRefused,
    );
    expect(() => gmailServiceAccountAdapter()).toThrow(MailSendRefused);
    expect(process.env.GMAIL_SA_KEY_PATH ?? "").toBe("");
  });

  it("does not invent a verification vendor", async () => {
    const result = await new TodoVerificationAdapter().verify("person@example.com");
    expect(result.provider).toBe("TODO: verification provider");
    expect(result.status).toBe("unknown");
  });
});
