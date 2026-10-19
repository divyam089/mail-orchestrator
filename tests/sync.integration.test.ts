import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { GMAIL_PAGE_SIZE } from "@/lib/mail/quota";
import { runScheduledSync } from "@/lib/mail/schedule";
import { connectInbox, syncInbox } from "@/lib/mail/sync";
import type {
  GmailFetchedMessage,
  GmailHistoryPage,
  GmailListPage,
  GmailProfile,
  GmailReadClient,
} from "@/lib/mail/types";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });
const INBOX = "divyam@usefigcel.com";

beforeAll(async () => {
  await migrate(connectionString);
  await seed(pool);
});

afterAll(async () => {
  await pool.end();
});

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    return await fn(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

type Call = { method: string; args?: unknown };

class FakeGmail implements GmailReadClient {
  readonly calls: Call[] = [];
  profile: GmailProfile;
  listPages: GmailListPage[] = [{ messages: [] }];
  messages = new Map<string, GmailFetchedMessage | null>();
  history: GmailHistoryPage = { expired: false, history: [], historyId: "1" };
  profileError: Error | null = null;

  constructor(email: string, historyId = "100") {
    this.profile = { emailAddress: email, historyId, messagesTotal: 3 };
  }

  async getProfile(): Promise<GmailProfile> {
    this.calls.push({ method: "getProfile" });
    if (this.profileError) throw this.profileError;
    return this.profile;
  }

  async listMessages(args: { pageToken?: string; maxResults: number }): Promise<GmailListPage> {
    this.calls.push({ method: "listMessages", args });
    const index = this.calls.filter((call) => call.method === "listMessages").length - 1;
    return this.listPages[Math.min(index, this.listPages.length - 1)];
  }

  async getMessage(id: string, format: "full" | "minimal"): Promise<GmailFetchedMessage | null> {
    this.calls.push({ method: "getMessage", args: { id, format } });
    return this.messages.get(id) ?? null;
  }

  async listHistory(args: { startHistoryId: string; pageToken?: string; maxResults: number }): Promise<GmailHistoryPage> {
    this.calls.push({ method: "listHistory", args });
    return this.history;
  }
}

function message(id: string, threadId: string, historyId: string, from: string): GmailFetchedMessage {
  return {
    id,
    threadId,
    historyId,
    labelIds: ["INBOX", "UNREAD"],
    snippet: `snippet ${id}`,
    internalDate: "1761000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: from },
        { name: "To", value: "Divyam Maru <divyam@usefigcel.com>" },
        { name: "Subject", value: `Subject ${id}` },
        { name: "Message-ID", value: `<${id}@example.com>` },
      ],
      body: { data: Buffer.from(`body ${id}`, "utf8").toString("base64url") },
      parts: [
        {
          filename: `${id}.pdf`,
          mimeType: "application/pdf",
          body: { size: 40, attachmentId: `att-${id}` },
        },
      ],
    },
  };
}

it("connect check marks the inbox active and leaves history_id empty", async () => {
  await withClient(async (client) => {
    const gmail = new FakeGmail(INBOX, "880");
    const result = await connectInbox(client, "Divyam@Usefigcel.com", gmail);
    expect(result).toMatchObject({ ok: true, email: INBOX, historyId: "880" });
    const row = await client.query<{ status: string; history_id: string | null; last_error: string | null; last_sync_at: Date | null }>(
      "SELECT status, history_id, last_error, last_sync_at FROM inboxes WHERE email = $1",
      [INBOX],
    );
    expect(row.rows[0]).toMatchObject({ status: "active", history_id: null, last_error: null, last_sync_at: null });
    expect(gmail.calls.map((call) => call.method)).toEqual(["getProfile"]);
  });
});

it("records one disconnect alert and updates it on the next failure", async () => {
  await withClient(async (client) => {
    const gmail = new FakeGmail(INBOX);
    gmail.profileError = new Error("delegation denied");
    const first = await connectInbox(client, INBOX, gmail);
    expect(first).toMatchObject({ ok: false });
    gmail.profileError = new Error("still down");
    await connectInbox(client, INBOX, gmail);

    const inbox = await client.query<{ status: string; last_error: string }>(
      "SELECT status, last_error FROM inboxes WHERE email = $1",
      [INBOX],
    );
    expect(inbox.rows[0].status).toBe("disconnected");
    expect(inbox.rows[0].last_error).toContain("still down");

    const alerts = await client.query<{ id: string; detail: string; acknowledged_at: Date | null }>(
      `SELECT a.id, a.detail, a.acknowledged_at
       FROM alerts a JOIN inboxes i ON i.id = a.inbox_id
       WHERE i.email = $1 AND a.kind = 'inbox_disconnect'`,
      [INBOX],
    );
    expect(alerts.rows).toHaveLength(1);
    expect(alerts.rows[0].detail).toContain("still down");
    expect(alerts.rows[0].acknowledged_at).toBeNull();

    gmail.profileError = null;
    const recovered = await connectInbox(client, INBOX, gmail);
    expect(recovered.ok).toBe(true);
    const open = await client.query(
      `SELECT 1 FROM alerts a JOIN inboxes i ON i.id = a.inbox_id
       WHERE i.email = $1 AND a.kind = 'inbox_disconnect' AND a.acknowledged_at IS NULL`,
      [INBOX],
    );
    expect(open.rows).toHaveLength(0);
    const status = await client.query<{ status: string; history_id: string | null }>(
      "SELECT status, history_id FROM inboxes WHERE email = $1",
      [INBOX],
    );
    expect(status.rows[0]).toMatchObject({ status: "active", history_id: null });
  });
});

it("full-syncs a bounded page, stays idempotent, and never asks for more than 50 ids", async () => {
  await withClient(async (client) => {
    const gmail = new FakeGmail(INBOX, "500");
    const firstPage = Array.from({ length: 2 }, (_, index) => ({ id: `p${index}`, threadId: "thread-a" }));
    const second = { id: "p2", threadId: "thread-b" };
    gmail.listPages = [
      { messages: firstPage, nextPageToken: "next" },
      { messages: [second, { id: "p-extra", threadId: "thread-c" }] },
    ];
    for (const ref of [...firstPage, second]) {
      gmail.messages.set(ref.id, message(ref.id, ref.threadId, ref.id === "p0" ? "321" : "100", "Ada <ada@client.com>"));
    }

    const result = await syncInbox(client, INBOX, gmail, { limit: 50 });
    expect(result).toMatchObject({ ok: true, mode: "full", stored: 3, historyId: "321" });

    const listed = gmail.calls.filter((call) => call.method === "listMessages");
    expect(listed.map((call) => (call.args as { maxResults: number }).maxResults)).toEqual([GMAIL_PAGE_SIZE, 48]);
    expect(listed.every((call) => (call.args as { maxResults: number }).maxResults <= 50)).toBe(true);
    expect(gmail.calls.some((call) => call.method === "getProfile")).toBe(false);

    const again = new FakeGmail(INBOX, "500");
    again.listPages = [{ messages: [...firstPage, second].map((ref) => ({ id: ref.id, threadId: ref.threadId })) }];
    for (const ref of [...firstPage, second]) {
      again.messages.set(ref.id, message(ref.id, ref.threadId, "321", "Ada <ada@client.com>"));
    }
    await client.query("UPDATE inboxes SET history_id = NULL WHERE email = $1", [INBOX]);
    const secondRun = await syncInbox(client, INBOX, again, { limit: 3 });
    expect(secondRun).toMatchObject({ ok: true, stored: 3 });

    const counts = await client.query<{ messages: string; threads: string; attachments: string }>(
      `SELECT
         (SELECT count(*) FROM messages m JOIN inboxes i ON i.id = m.inbox_id WHERE i.email = $1) AS messages,
         (SELECT count(*) FROM threads t JOIN inboxes i ON i.id = t.inbox_id WHERE i.email = $1) AS threads,
         (SELECT count(*) FROM attachments a
            JOIN messages m ON m.id = a.message_id
            JOIN inboxes i ON i.id = m.inbox_id
          WHERE i.email = $1) AS attachments`,
      [INBOX],
    );
    expect(counts.rows[0]).toMatchObject({ messages: "3", threads: "2", attachments: "3" });
    const body = await client.query<{ body_text: string; filename: string }>(
      `SELECT m.body_text, a.filename
       FROM messages m
       JOIN inboxes i ON i.id = m.inbox_id
       JOIN attachments a ON a.message_id = m.id
       WHERE i.email = $1 AND m.gmail_message_id = 'p0'`,
      [INBOX],
    );
    expect(body.rows[0]).toMatchObject({ body_text: "body p0", filename: "p0.pdf" });
  });
});

it("falls back to a full sync when history.list returns 404", async () => {
  await withClient(async (client) => {
    await client.query("UPDATE inboxes SET history_id = '15', status = 'active' WHERE email = $1", [INBOX]);
    const gmail = new FakeGmail(INBOX, "900");
    gmail.history = { expired: true };
    gmail.listPages = [{ messages: [{ id: "fresh", threadId: "thread-fresh" }] }];
    gmail.messages.set("fresh", message("fresh", "thread-fresh", "900", "Bea <bea@client.com>"));

    const result = await syncInbox(client, INBOX, gmail, { limit: 5 });
    expect(result).toMatchObject({ ok: true, mode: "full", stored: 1, historyId: "900" });
    expect(gmail.calls.map((call) => call.method)).toEqual(["listHistory", "listMessages", "getMessage"]);
    const row = await client.query<{ history_id: string }>("SELECT history_id FROM inboxes WHERE email = $1", [INBOX]);
    expect(row.rows[0].history_id).toBe("900");
  });
});

it("applies incremental history with minimal reads and a local tombstone", async () => {
  await withClient(async (client) => {
    const seeded = new FakeGmail(INBOX);
    seeded.listPages = [
      {
        messages: [
          { id: "keep", threadId: "thread-keep" },
          { id: "gone", threadId: "thread-gone" },
        ],
      },
    ];
    seeded.messages.set("keep", message("keep", "thread-keep", "10", "Ada <ada@client.com>"));
    seeded.messages.set("gone", message("gone", "thread-gone", "10", "Cara <cara@client.com>"));
    await syncInbox(client, INBOX, seeded, { limit: 2 });

    const gmail = new FakeGmail(INBOX);
    gmail.history = {
      expired: false,
      historyId: "80",
      history: [
        {
          id: "40",
          messagesAdded: [{ id: "new", threadId: "thread-new" }],
          labelsAdded: [{ id: "keep", threadId: "thread-keep" }],
          messagesDeleted: [{ id: "gone", threadId: "thread-gone" }],
        },
        {
          id: "41",
          messagesAdded: [{ id: "later", threadId: "thread-later" }],
        },
      ],
    };
    gmail.messages.set("new", message("new", "thread-new", "40", "Dee <dee@client.com>"));
    gmail.messages.set("keep", {
      id: "keep",
      threadId: "thread-keep",
      labelIds: ["INBOX"],
      snippet: "snippet keep",
    });
    gmail.messages.set("later", message("later", "thread-later", "41", "Eve <eve@client.com>"));

    const result = await syncInbox(client, INBOX, gmail, { limit: 1 });
    expect(result).toMatchObject({ ok: true, mode: "partial", removed: 1, historyId: "40" });
    expect(gmail.calls.some((call) => call.method === "listMessages")).toBe(false);
    const historyCall = gmail.calls.find((call) => call.method === "listHistory");
    expect(historyCall?.args).toMatchObject({ startHistoryId: "10", maxResults: GMAIL_PAGE_SIZE });
    const gets = gmail.calls.filter((call) => call.method === "getMessage");
    expect(gets.map((call) => call.args)).toEqual([
      { id: "new", format: "full" },
      { id: "keep", format: "minimal" },
    ]);

    const rows = await client.query<{ gmail_message_id: string; removed_at: Date | null; is_read: boolean; body_text: string | null }>(
      `SELECT gmail_message_id, removed_at, is_read, body_text
       FROM messages m JOIN inboxes i ON i.id = m.inbox_id
       WHERE i.email = $1
       ORDER BY gmail_message_id`,
      [INBOX],
    );
    const byId = new Map(rows.rows.map((row) => [row.gmail_message_id, row]));
    expect(byId.get("gone")?.removed_at).not.toBeNull();
    expect(byId.get("keep")?.is_read).toBe(true);
    expect(byId.get("keep")?.body_text).toBe("body keep");
    expect(byId.has("new")).toBe(true);
    expect(byId.has("later")).toBe(false);
  });
});

it("rejects an unknown inbox and an over-limit sync before any Gmail call", async () => {
  await withClient(async (client) => {
    const gmail = new FakeGmail(INBOX);
    await expect(syncInbox(client, "stranger@example.com", gmail, { limit: 1 })).rejects.toThrow(/Unknown inbox/);
    await expect(connectInbox(client, "stranger@example.com", gmail)).rejects.toThrow(/Unknown inbox/);
    await expect(syncInbox(client, INBOX, gmail, { limit: 51 })).rejects.toThrow(/1 to 50/);
    expect(gmail.calls).toEqual([]);
    const row = await client.query<{ status: string }>("SELECT status FROM inboxes WHERE email = $1", [INBOX]);
    expect(row.rows[0].status).toBe("not_connected");
  });
});

it("runs one scheduled pass per inbox and does not sleep after the last tick", async () => {
  await withClient(async (client) => {
    const slept: number[] = [];
    const seen: string[] = [];
    const targets = [INBOX, "piyush@usefigcel.com"];
    const result = await runScheduledSync({
      db: client,
      inboxes: targets,
      limit: 1,
      intervalMs: 60_000,
      iterations: 1,
      sleep: async (ms) => {
        slept.push(ms);
      },
      clientFor: async (email) => {
        seen.push(email);
        return new FakeGmail(email, "7");
      },
    });
    expect(result.ticks).toBe(1);
    expect(seen).toEqual(targets);
    expect(slept).toEqual([]);
    expect(result.results.every((item) => item.ok && item.mode === "full")).toBe(true);

    await expect(
      runScheduledSync({
        db: client,
        limit: 1,
        intervalMs: 1_000,
        iterations: 1,
        inboxes: targets,
        clientFor: async () => {
          throw new Error("interval check must happen first");
        },
      }),
    ).rejects.toThrow(/at least 60000ms/);
  });
});
