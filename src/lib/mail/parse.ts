import type { GmailFetchedMessage, GmailPayload } from "@/lib/mail/types";

const BODY_CAP = 100_000;

export type ParsedAddress = { name: string | null; email: string };

export type ParsedGmailMessage = {
  gmailId: string;
  threadId: string;
  historyId: string | null;
  rfcMessageId: string | null;
  fromEmail: string | null;
  fromName: string | null;
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  internalDate: Date | null;
  labelIds: string[];
  isRead: boolean;
  isStarred: boolean;
  direction: "in" | "out";
  isArchived: boolean;
  attachments: { filename: string | null; mimeType: string | null; sizeBytes: number | null; gmailAttachmentId: string }[];
};

function header(payload: GmailPayload | undefined, name: string): string | null {
  const found = payload?.headers?.find((item) => item.name.toLowerCase() === name.toLowerCase());
  const value = found?.value?.trim();
  return value ? value : null;
}

function decodeBase64Url(data: string): string {
  const pad = data.length % 4 === 0 ? "" : "=".repeat(4 - (data.length % 4));
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return Buffer.from(normalized, "base64").toString("utf8");
}

function cap(value: string | null): string | null {
  if (value == null) return null;
  return value.length > BODY_CAP ? value.slice(0, BODY_CAP) : value;
}

export function parseAddressList(value: string | null): ParsedAddress[] {
  if (!value) return [];
  const found: ParsedAddress[] = [];
  const pattern = /(?:"([^"]*)"\s*)?<([^<>\s]+@[^<>\s]+)>|([^\s,;"<>]+@[^\s,;"<>]+)/g;
  for (const match of value.matchAll(pattern)) {
    const email = (match[2] ?? match[3] ?? "").trim().toLowerCase();
    if (!email) continue;
    const name = match[1]?.trim() || null;
    found.push({ name, email });
  }
  return found;
}

function walk(
  part: GmailPayload | undefined,
  acc: { text: string | null; html: string | null; attachments: ParsedGmailMessage["attachments"] },
): void {
  if (!part) return;
  const attachmentId = part.body?.attachmentId;
  if (attachmentId || (part.filename && part.filename.length > 0)) {
    if (attachmentId) {
      acc.attachments.push({
        filename: part.filename || null,
        mimeType: part.mimeType ?? null,
        sizeBytes: part.body?.size ?? null,
        gmailAttachmentId: attachmentId,
      });
    }
  }
  if (!attachmentId && part.body?.data) {
    const decoded = cap(decodeBase64Url(part.body.data));
    if (part.mimeType === "text/plain" && acc.text == null) acc.text = decoded;
    if (part.mimeType === "text/html" && acc.html == null) acc.html = decoded;
    if (!part.mimeType && acc.text == null) acc.text = decoded;
  }
  for (const child of part.parts ?? []) walk(child, acc);
}

export function parseGmailMessage(message: GmailFetchedMessage, inboxEmail: string): ParsedGmailMessage {
  const acc: { text: string | null; html: string | null; attachments: ParsedGmailMessage["attachments"] } = {
    text: null,
    html: null,
    attachments: [],
  };
  walk(message.payload, acc);
  const from = parseAddressList(header(message.payload, "From"))[0] ?? null;
  const labelIds = message.labelIds ?? [];
  const fromEmail = from?.email ?? null;
  const direction: "in" | "out" =
    fromEmail === inboxEmail || labelIds.includes("SENT") ? "out" : "in";
  const internal = message.internalDate ? new Date(Number(message.internalDate)) : null;
  return {
    gmailId: message.id,
    threadId: message.threadId,
    historyId: message.historyId ? String(message.historyId) : null,
    rfcMessageId: header(message.payload, "Message-ID") ?? header(message.payload, "Message-Id"),
    fromEmail,
    fromName: from?.name ?? null,
    to: parseAddressList(header(message.payload, "To")),
    cc: parseAddressList(header(message.payload, "Cc")),
    subject: header(message.payload, "Subject"),
    snippet: message.snippet ?? null,
    bodyText: acc.text,
    bodyHtml: acc.html,
    internalDate: internal && !Number.isNaN(internal.getTime()) ? internal : null,
    labelIds,
    isRead: !labelIds.includes("UNREAD"),
    isStarred: labelIds.includes("STARRED"),
    direction,
    isArchived:
      direction === "in" &&
      !labelIds.includes("INBOX") &&
      !labelIds.includes("DRAFT") &&
      !labelIds.includes("SPAM") &&
      !labelIds.includes("TRASH"),
    attachments: acc.attachments,
  };
}
