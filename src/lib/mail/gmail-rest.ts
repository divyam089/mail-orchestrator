import {
  GmailApiError,
  GMAIL_MAX_ATTEMPTS,
  backoffDelayMs,
  shouldRetryGmail,
} from "@/lib/mail/backoff";
import { assertGmailReadOnly } from "@/lib/mail/readonly";
import type {
  GmailFetchedMessage,
  GmailGetFormat,
  GmailHistoryPage,
  GmailHistoryRecord,
  GmailListPage,
  GmailProfile,
  GmailReadClient,
} from "@/lib/mail/types";

export type GmailFetch = (
  url: string,
  init: { method: "GET"; headers: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

type RequestOpts = {
  getToken: () => Promise<string>;
  fetchImpl?: GmailFetch;
  sleep?: (ms: number) => Promise<void>;
  randomMs?: () => number;
  maxAttempts?: number;
};

const GMAIL_ORIGIN = "https://gmail.googleapis.com";

function errorReason(body: unknown): { reason: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { reason: null, message: null };
  const error = (body as { error?: { message?: string; errors?: { reason?: string }[] } }).error;
  return {
    reason: error?.errors?.[0]?.reason ?? null,
    message: error?.message ?? null,
  };
}

export async function gmailGet(
  opts: RequestOpts & { path: string; query?: Record<string, string | undefined> },
): Promise<{ status: number; body: unknown }> {
  assertGmailReadOnly("GET", opts.path);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const randomMs = opts.randomMs ?? (() => Math.floor(Math.random() * 1001));
  const maxAttempts = opts.maxAttempts ?? GMAIL_MAX_ATTEMPTS;
  const url = new URL(GMAIL_ORIGIN + opts.path);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value != null && value !== "") url.searchParams.set(key, value);
  }

  let lastError: GmailApiError | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await opts.getToken();
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = { raw: text.slice(0, 300) };
      }
    }
    if (response.status >= 200 && response.status < 300) return { status: response.status, body };
    const parsed = errorReason(body);
    lastError = new GmailApiError(
      response.status,
      parsed.reason,
      opts.path,
      `Gmail API ${response.status}${parsed.reason ? ` ${parsed.reason}` : ""} on ${opts.path}` +
        (parsed.message ? `: ${parsed.message}` : ""),
    );
    const retryAfter = Number(response.headers.get("retry-after"));
    if (!shouldRetryGmail(response.status, parsed.reason) || attempt === maxAttempts) throw lastError;
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : backoffDelayMs(attempt - 1, randomMs());
    await sleep(delay);
  }
  throw lastError ?? new GmailApiError(0, null, opts.path, `Gmail API failed on ${opts.path}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function messageRefs(value: unknown): { id: string; threadId: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const message = asRecord(asRecord(item).message ?? item);
    const id = message.id;
    const threadId = message.threadId;
    if (typeof id !== "string" || typeof threadId !== "string") return [];
    return [{ id, threadId }];
  });
}

export function createGmailReadClient(opts: RequestOpts): GmailReadClient {
  return {
    async getProfile(): Promise<GmailProfile> {
      const { body } = await gmailGet({ ...opts, path: "/gmail/v1/users/me/profile" });
      const record = asRecord(body);
      const emailAddress = typeof record.emailAddress === "string" ? record.emailAddress : "";
      const historyId = record.historyId == null ? "" : String(record.historyId);
      if (!emailAddress || !historyId) {
        throw new GmailApiError(200, null, "/gmail/v1/users/me/profile", "Gmail profile was missing emailAddress or historyId");
      }
      return {
        emailAddress,
        historyId,
        messagesTotal: typeof record.messagesTotal === "number" ? record.messagesTotal : undefined,
      };
    },

    async listMessages(args): Promise<GmailListPage> {
      const { body } = await gmailGet({
        ...opts,
        path: "/gmail/v1/users/me/messages",
        query: { maxResults: String(args.maxResults), pageToken: args.pageToken },
      });
      const record = asRecord(body);
      return {
        messages: messageRefs(record.messages),
        nextPageToken: typeof record.nextPageToken === "string" ? record.nextPageToken : undefined,
      };
    },

    async getMessage(id, format: GmailGetFormat): Promise<GmailFetchedMessage | null> {
      try {
        const { body } = await gmailGet({
          ...opts,
          path: `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
          query: { format },
        });
        return body as GmailFetchedMessage;
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) return null;
        throw error;
      }
    },

    async listHistory(args): Promise<GmailHistoryPage> {
      try {
        const { body } = await gmailGet({
          ...opts,
          path: "/gmail/v1/users/me/history",
          query: {
            startHistoryId: args.startHistoryId,
            maxResults: String(args.maxResults),
            pageToken: args.pageToken,
          },
        });
        const record = asRecord(body);
        const history = Array.isArray(record.history)
          ? record.history.map((item): GmailHistoryRecord => {
              const row = asRecord(item);
              return {
                id: String(row.id ?? ""),
                messagesAdded: messageRefs(row.messagesAdded),
                messagesDeleted: messageRefs(row.messagesDeleted),
                labelsAdded: messageRefs(row.labelsAdded),
                labelsRemoved: messageRefs(row.labelsRemoved),
              };
            })
          : [];
        return {
          expired: false,
          history,
          historyId: String(record.historyId ?? args.startHistoryId),
          nextPageToken: typeof record.nextPageToken === "string" ? record.nextPageToken : undefined,
        };
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) return { expired: true };
        throw error;
      }
    },
  };
}
