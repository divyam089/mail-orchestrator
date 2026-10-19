import { describe, expect, it } from "vitest";
import { buildPlainMime, toRaw } from "@/lib/send/mime";
import { composeMessage, previewLead, renderTemplate } from "@/lib/send/template";
import { deliverBehindGates } from "@/lib/send/execute";
import { MailSendRefused, type MailAdapter } from "@/lib/mail/adapter";

describe("templates", () => {
  it("resolves spintax and required or fallback merge fields", () => {
    const first = renderTemplate("{Hi|Hello} {{first_name|there}}", { first_name: "Ada" }, () => 0);
    expect(first.text).toBe("Hi Ada");
    expect(first.missing).toEqual([]);
    const fallback = renderTemplate("{{first_name|there}}", {}, () => 0);
    expect(fallback.text).toBe("there");
    const missing = renderTemplate("{{company}}", {}, () => 0.9);
    expect(missing.missing).toEqual(["company"]);
    const spun = renderTemplate("{Hi|Hello}", {}, () => 0.9);
    expect(spun.text).toBe("Hello");
  });

  it("previews plain text with a footer and leaves tracking off", () => {
    const preview = previewLead({
      subjectTemplate: "Hello {{first_name}}",
      bodyTemplate: "We help {{company|teams}}.\nSee https://figcel.example/story",
      vars: { first_name: "Ada", unsub_token: "tok" },
      stepNumber: 1,
      firstSubject: null,
      unsubscribeUrl: "https://unsub.test/u/tok",
      legalName: "Figcel Inc.",
      postalAddress: "1 Market Street, San Francisco, CA 94105",
      trackOpens: false,
      trackClicks: false,
      rng: () => 0,
    });
    expect(preview.subject).toBe("Hello Ada");
    expect(preview.body).toContain("Unsubscribe: https://unsub.test/u/tok");
    expect(preview.body).toContain("1 Market Street, San Francisco, CA 94105");
    expect(preview.body).not.toContain("/o/");
    expect(preview.body).not.toContain("/c/");
    const tracked = composeMessage({
      subjectTemplate: "Hello",
      bodyTemplate: "See https://figcel.example/story",
      vars: { unsub_token: "tok" },
      stepNumber: 2,
      firstSubject: "Hello",
      unsubscribeUrl: "https://unsub.test/u/tok",
      legalName: "Figcel Inc.",
      postalAddress: "1 Market Street",
      trackOpens: true,
      trackClicks: true,
      rng: () => 0,
    });
    expect(tracked.subject).toBe("Re: Hello");
    expect(tracked.body).toContain("/c/tok?");
    expect(tracked.body).toContain("/o/tok");
  });
});

describe("mime", () => {
  it("builds a plain-text reply with RFC 8058 headers", () => {
    const built = buildPlainMime({
      fromEmail: "divyam@usefigcel.com",
      fromName: "Divyam Maru",
      to: "ada@acme.test",
      subject: "Re: Hello Ada",
      body: "Following up.\n\nUnsubscribe: https://unsub.test/u/tok\n\nFigcel Inc.\n1 Market Street\n",
      messageId: "<step2@usefigcel.com>",
      date: new Date("2026-10-22T14:00:00.000Z"),
      inReplyTo: "<step1@usefigcel.com>",
      references: "<step1@usefigcel.com>",
      listUnsubscribeHttps: "https://unsub.test/u/tok",
      listUnsubscribeMailto: "mailto:divyam@usefigcel.com?subject=unsubscribe",
    });
    expect(built.mime).toContain("Content-Type: text/plain");
    expect(built.mime).toContain("Subject: Re: Hello Ada");
    expect(built.mime).toContain("In-Reply-To: <step1@usefigcel.com>");
    expect(built.mime).toContain("References: <step1@usefigcel.com>");
    expect(built.mime).toContain("List-Unsubscribe: <https://unsub.test/u/tok>, <mailto:divyam@usefigcel.com?subject=unsubscribe>");
    expect(built.mime).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
    expect(built.mime).not.toContain("<html");
    expect(Buffer.from(toRaw(built.mime), "base64url").toString("utf8")).toBe(built.mime);
  });

  it("refuses the adapter when the gate is closed", async () => {
    let calls = 0;
    const adapter: MailAdapter = {
      provider: "mock",
      async send() {
        calls += 1;
        return { id: "x", threadId: "y" };
      },
    };
    await expect(deliverBehindGates(adapter, { action: "defer" }, { from: "a@b.c", raw: "x" })).rejects.toBeInstanceOf(
      MailSendRefused,
    );
    expect(calls).toBe(0);
  });
});
