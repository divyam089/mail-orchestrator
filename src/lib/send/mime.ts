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

export type OutboundAttachment = { filename: string; mimeType: string; content: Buffer };

export type RichMimeInput = {
  fromEmail: string;
  fromName: string;
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
  html?: string | null;
  messageId?: string;
  date?: Date;
  inReplyTo?: string | null;
  references?: string | null;
  listUnsubscribeHttps?: string | null;
  listUnsubscribeMailto?: string | null;
  attachments?: OutboundAttachment[];
};

function wrapBase64(value: Buffer): string {
  return value.toString("base64").replace(/(.{76})/g, "$1\r\n");
}

function safeFilename(name: string): string {
  return name.replace(/[\r\n"]/g, "") || "attachment";
}

/** Multipart alternative, plus attachments. Reply headers are included when present. */
export function buildRichMime(input: RichMimeInput): BuiltMime {
  const domain = input.fromEmail.split("@")[1] || "localhost";
  const messageId = input.messageId ?? newMessageId(domain);
  const mixed = `mix_${randomBytes(8).toString("hex")}`;
  const alt = `alt_${randomBytes(8).toString("hex")}`;
  const headers = [
    `From: ${formatAddress(input.fromName, input.fromEmail)}`,
    `To: ${input.to.join(", ")}`,
    input.cc && input.cc.length > 0 ? `Cc: ${input.cc.join(", ")}` : null,
    `Subject: ${input.subject}`,
    `Date: ${formatDate(input.date ?? new Date())}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    input.inReplyTo ? `References: ${input.references || input.inReplyTo}` : null,
    input.listUnsubscribeHttps
      ? `List-Unsubscribe: <${input.listUnsubscribeHttps}>, <${input.listUnsubscribeMailto}>`
      : null,
    input.listUnsubscribeHttps ? "List-Unsubscribe-Post: List-Unsubscribe=One-Click" : null,
  ].filter((line): line is string => Boolean(line));

  const textPart = [
    `Content-Type: text/plain; charset="utf-8"`,
    "Content-Transfer-Encoding: 8bit",
    "",
    input.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
  ].join("\r\n");
  const htmlPart = input.html
    ? [
        `Content-Type: text/html; charset="utf-8"`,
        "Content-Transfer-Encoding: 8bit",
        "",
        input.html.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"),
      ].join("\r\n")
    : null;
  const alternative = htmlPart
    ? [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        "",
        `--${alt}`,
        textPart,
        `--${alt}`,
        htmlPart,
        `--${alt}--`,
      ].join("\r\n")
    : textPart;
  const files = input.attachments ?? [];
  let body: string;
  if (files.length === 0 && !htmlPart) {
    headers.push('Content-Type: text/plain; charset="utf-8"', "Content-Transfer-Encoding: 8bit");
    body = input.text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  } else if (files.length === 0) {
    headers.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
    body = [`--${alt}`, textPart, `--${alt}`, htmlPart, `--${alt}--`, ""].join("\r\n");
  } else {
    headers.push(`Content-Type: multipart/mixed; boundary="${mixed}"`);
    const parts = [`--${mixed}`, alternative];
    for (const file of files) {
      parts.push(
        `--${mixed}`,
        `Content-Type: ${file.mimeType || "application/octet-stream"}; name="${safeFilename(file.filename)}"`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; filename="${safeFilename(file.filename)}"`,
        "",
        wrapBase64(file.content),
      );
    }
    parts.push(`--${mixed}--`, "");
    body = parts.join("\r\n");
  }
  const mime = `${headers.join("\r\n")}\r\n\r\n${body}`;
  return { mime, messageId, raw: toRaw(mime) };
}

export function unsubscribeUrls(base: string, token: string, inboxEmail: string): { https: string; mailto: string } {
  const root = base.replace(/\/$/, "");
  return {
    https: `${root}/u/${token}`,
    mailto: `mailto:${inboxEmail}?subject=unsubscribe`,
  };
}
