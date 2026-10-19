import { describe, expect, it } from "vitest";
import { parseAddressList, parseGmailMessage } from "@/lib/mail/parse";
import type { GmailFetchedMessage } from "@/lib/mail/types";

function encoded(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

describe("parse gmail message", () => {
  it("reads headers, both bodies, and attachment metadata only", () => {
    const message: GmailFetchedMessage = {
      id: "m1",
      threadId: "t1",
      historyId: "44",
      labelIds: ["INBOX", "UNREAD"],
      snippet: "plain",
      internalDate: "1761000000000",
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: '"Ada Lovelace" <Ada@Example.com>' },
          { name: "To", value: "Divyam Maru <divyam@usefigcel.com>, other@client.com" },
          { name: "Cc", value: "ops@client.com" },
          { name: "Subject", value: "Intro" },
          { name: "Message-ID", value: "<m1@example.com>" },
        ],
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [
              { mimeType: "text/plain", body: { data: encoded("plain body") } },
              { mimeType: "text/html", body: { data: encoded("<p>html</p>") } },
            ],
          },
          {
            filename: "deck.pdf",
            mimeType: "application/pdf",
            body: { size: 1200, attachmentId: "att-1" },
          },
        ],
      },
    };
    const parsed = parseGmailMessage(message, "divyam@usefigcel.com");
    expect(parsed.fromEmail).toBe("ada@example.com");
    expect(parsed.fromName).toBe("Ada Lovelace");
    expect(parsed.to.map((item) => item.email)).toEqual(["divyam@usefigcel.com", "other@client.com"]);
    expect(parsed.cc).toEqual([{ name: null, email: "ops@client.com" }]);
    expect(parsed.subject).toBe("Intro");
    expect(parsed.rfcMessageId).toBe("<m1@example.com>");
    expect(parsed.bodyText).toBe("plain body");
    expect(parsed.bodyHtml).toBe("<p>html</p>");
    expect(parsed.direction).toBe("in");
    expect(parsed.isRead).toBe(false);
    expect(parsed.attachments).toEqual([
      { filename: "deck.pdf", mimeType: "application/pdf", sizeBytes: 1200, gmailAttachmentId: "att-1" },
    ]);
    expect(JSON.stringify(parsed.attachments)).not.toContain("bytes");
  });

  it("marks mail from the inbox or the SENT label as outbound and caps the body", () => {
    const outbound = parseGmailMessage(
      {
        id: "m2",
        threadId: "t2",
        labelIds: ["SENT"],
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: "someone@client.com" }],
          body: { data: encoded("sent") },
        },
      },
      "divyam@usefigcel.com",
    );
    expect(outbound.direction).toBe("out");

    const huge = "a".repeat(100_001);
    const capped = parseGmailMessage(
      {
        id: "m3",
        threadId: "t3",
        labelIds: ["INBOX"],
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "From", value: "reader@client.com" }],
          body: { data: encoded(huge) },
        },
      },
      "divyam@usefigcel.com",
    );
    expect(capped.bodyText).toHaveLength(100_000);
    expect(parseAddressList(null)).toEqual([]);
  });
});
