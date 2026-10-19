import { randomBytes } from "node:crypto";

export function newMessageId(domain: string): string {
  return `<${randomBytes(12).toString("hex")}@${domain}>`;
}

export function newUnsubToken(): string {
  return randomBytes(12).toString("base64url");
}

function formatAddress(name: string, email: string): string {
  if (!name.trim()) return email;
  if (/[",\\]/.test(name)) return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${email}>`;
  return `${name} <${email}>`;
}

function formatDate(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

export type MimeInput = {
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  body: string;
  messageId?: string;
  date?: Date;
  inReplyTo?: string | null;
  references?: string | null;
  listUnsubscribeHttps: string;
  listUnsubscribeMailto: string;
};

export type BuiltMime = { mime: string; messageId: string; raw: string };

/** Plain-text RFC 5322 with RFC 8058 one-click unsubscribe headers. */
export function buildPlainMime(input: MimeInput): BuiltMime {
  const domain = input.fromEmail.split("@")[1] || "localhost";
  const messageId = input.messageId ?? newMessageId(domain);
  const lines = [
    `From: ${formatAddress(input.fromName, input.fromEmail)}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${formatDate(input.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: 8bit",
  ];
  if (input.inReplyTo) {
    lines.push(`In-Reply-To: ${input.inReplyTo}`);
    lines.push(`References: ${input.references || input.inReplyTo}`);
  }
  lines.push(`List-Unsubscribe: <${input.listUnsubscribeHttps}>, <${input.listUnsubscribeMailto}>`);
  lines.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  const body = input.body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  const mime = `${lines.join("\r\n")}\r\n\r\n${body}`;
  return { mime, messageId, raw: toRaw(mime) };
}

export function toRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

export function unsubscribeUrls(base: string, token: string, inboxEmail: string): { https: string; mailto: string } {
  const root = base.replace(/\/$/, "");
  return {
    https: `${root}/u/${token}`,
    mailto: `mailto:${inboxEmail}?subject=unsubscribe`,
  };
}
