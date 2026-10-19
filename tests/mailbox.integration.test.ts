import { afterAll, beforeAll, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { migrate } from "@/lib/db/migrate";
import { seed } from "@/lib/db/seed";
import { readSendingEnabled } from "@/lib/gates";
import type { MailAdapter } from "@/lib/mail/adapter";
import { composeManual } from "@/lib/mail/compose";
import { applyLabel, listThreads, loadThread, relabelMessage, releaseSnoozed, setMessageState } from "@/lib/mail/mailbox";
import { applyMirror, readMirrorEnabled } from "@/lib/mail/mirror";
import { assertGmailReadOnly } from "@/lib/mail/readonly";
import { syncInbox } from "@/lib/mail/sync";
import type { GmailFetchedMessage, GmailHistoryPage, GmailListPage, GmailProfile, GmailReadClient } from "@/lib/mail/types";
import { stopFromInbound } from "@/lib/send/inbound";
import { loadReviewDesk } from "@/lib/send/desk";

const connectionString = process.env.DATABASE_URL_TEST;
if (!connectionString) throw new Error("DATABASE_URL_TEST is not set");

const pool = new Pool({ connectionString });

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

function recorder() {
  const calls: { to?: string; threadId?: string; from: string }[] = [];
  const adapter: MailAdapter = {
    provider: "mock",
    async send(message) {
      calls.push({ to: message.to, threadId: message.threadId, from: message.from });
      return { id: "g-should-not-run", threadId: message.threadId ?? "t" };
    },
  };
  return { adapter, calls };
}

async function inboxId(client: PoolClient, email: string) {
  const result = await client.query<{ id: string }>("SELECT id FROM inboxes WHERE email = $1", [email]);
  return result.rows[0].id;
}

async function addContact(client: PoolClient, email: string, company: string) {
  const result = await client.query<{ id: string }>(
    `INSERT INTO contacts (display_email, normalized_email, domain, first_name, company, timezone, verification_status)
     VALUES ($1, $1, split_part($1, '@', 2), 'Ada', $2, 'America/New_York', 'valid')
     RETURNING id`,
    [email, company],
  );
  return result.rows[0].id;
}

async function addThread(
  client: PoolClient,
  input: {
    inbox: string;
    gmailThread: string;
    subject: string;
    contactId?: string | null;
    campaignId?: string | null;
    from: string;
    to: string;
    body: string;
    rfc: string;
    gmailId: string;
    when: string;
  },
) {
  const box = await inboxId(client, input.inbox);
  const thread = await client.query<{ id: string }>(
    `INSERT INTO threads (inbox_id, gmail_thread_id, subject, snippet, last_message_at, contact_id, campaign_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [box, input.gmailThread, input.subject, input.body.slice(0, 80), input.when, input.contactId ?? null, input.campaignId ?? null],
  );
  const message = await client.query<{ id: string }>(
    `INSERT INTO messages (
       inbox_id, thread_row_id, gmail_message_id, rfc_message_id, direction,
       from_email, to_addrs, subject, body_text, snippet, internal_date, is_read, labels
     ) VALUES (
       $1, $2, $3, $4, 'in',
       $5, $6::jsonb, $7, $8, $8, $9, false, '["INBOX","UNREAD"]'::jsonb
     ) RETURNING id`,
    [
      box,
      thread.rows[0].id,
      input.gmailId,
      input.rfc,
      input.from,
      JSON.stringify([{ email: input.to }]),
      input.subject,
      input.body,
      input.when,
    ],
  );
  return { threadId: thread.rows[0].id, messageId: message.rows[0].id, inboxId: box };
}

class FakeGmail implements GmailReadClient {
  constructor(
    private readonly email: string,
    private readonly message: GmailFetchedMessage,
  ) {}

  async getProfile(): Promise<GmailProfile> {
    return { emailAddress: this.email, historyId: "50" };
  }

  async listMessages(): Promise<GmailListPage> {
    return { messages: [{ id: this.message.id, threadId: this.message.threadId }] };
  }

  async getMessage(): Promise<GmailFetchedMessage> {
    return this.message;
  }

  async listHistory(): Promise<GmailHistoryPage> {
    return {
      expired: false,
      historyId: "51",
      history: [{ id: "51", labelsAdded: [{ id: this.message.id, threadId: this.message.threadId }] }],
    };
  }
}

function gmailMessage(labels: string[]): GmailFetchedMessage {
  return {
    id: "m-keep",
    threadId: "t-keep",
    historyId: "50",
    labelIds: labels,
    snippet: "keep this star",
    internalDate: "1761000000000",
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: "Ada <ada@acme.test>" },
        { name: "To", value: "divyam@usefigcel.com" },
        { name: "Subject", value: "Keep the star" },
        { name: "Message-ID", value: "<keep@client.test>" },
      ],
      body: { data: Buffer.from("please keep the local star", "utf8").toString("base64url") },
    },
  };
}

it("keeps the kill switch and the Gmail mirror off", () => {
  expect(readSendingEnabled()).toBe(false);
  expect(readMirrorEnabled()).toBe(false);
  expect(process.env.GMAIL_MIRROR_ENABLED ?? "false").not.toBe("true");
  expect(() => assertGmailReadOnly("POST", "/gmail/v1/users/me/messages/abc/modify")).toThrow(/POST/);
});

it("searches sender, recipient, subject, and body, and filters by campaign and label", async () => {
  await withClient(async (client) => {
    const ada = await addContact(client, "ada@acme.test", "Acme");
    const bea = await addContact(client, "bea@northwind.test", "Northwind");
    const campaign = await client.query<{ id: string }>(
      "INSERT INTO campaigns (name, status) VALUES ('Zirconium pilot', 'active') RETURNING id",
    );
    const other = await client.query<{ id: string }>("INSERT INTO campaigns (name, status) VALUES ('Other', 'active') RETURNING id");
    const hit = await addThread(client, {
      inbox: "divyam@usefigcel.com",
      gmailThread: "t-zirconium",
      subject: "Pricing note",
      contactId: ada,
      campaignId: campaign.rows[0].id,
      from: "ada@acme.test",
      to: "divyam@usefigcel.com",
      body: "The zirconium sample is on its way to quinn@northwind.test",
      rfc: "<zirconium@client.test>",
      gmailId: "m-zirconium",
      when: "2026-10-19T15:00:00.000Z",
    });
    await addThread(client, {
      inbox: "piyush@meetfigcel.com",
      gmailThread: "t-other-inbox",
      subject: "Different desk",
      contactId: bea,
      campaignId: other.rows[0].id,
      from: "bea@northwind.test",
      to: "piyush@meetfigcel.com",
      body: "Nothing about that mineral",
      rfc: "<other@client.test>",
      gmailId: "m-other",
      when: "2026-10-19T14:00:00.000Z",
    });
    await applyLabel(client, { messageId: hit.messageId, name: "follow-up", actor: "test", source: "system" });

    const byBody = await listThreads(client, { q: "zirconium" });
    expect(byBody.map((row) => row.id)).toEqual([hit.threadId]);
    const byRecipient = await listThreads(client, { q: "quinn@northwind.test" });
    expect(byRecipient.map((row) => row.id)).toContain(hit.threadId);
    const byCampaign = await listThreads(client, { campaignId: campaign.rows[0].id });
    expect(byCampaign.map((row) => row.id)).toEqual([hit.threadId]);
    const byLabel = await listThreads(client, { label: "follow-up" });
    expect(byLabel.map((row) => row.id)).toEqual([hit.threadId]);
    const byInbox = await listThreads(client, { inboxId: await inboxId(client, "piyush@meetfigcel.com") });
    expect(byInbox.every((row) => row.inboxEmail === "piyush@meetfigcel.com")).toBe(true);
    expect(byInbox.some((row) => row.subject === "Different desk")).toBe(true);

    const adaThread = await loadThread(client, hit.threadId);
    const beaRow = byInbox.find((row) => row.subject === "Different desk");
    const beaThread = await loadThread(client, beaRow!.id);
    expect(adaThread?.context.contact?.email).toBe("ada@acme.test");
    expect(adaThread?.context.contact?.company).toBe("Acme");
    expect(adaThread?.messages[0]?.inboxEmail).toBe("divyam@usefigcel.com");
    expect(beaThread?.context.contact?.email).toBe("bea@northwind.test");
    expect(beaThread?.context.contact?.company).toBe("Northwind");
    expect(beaThread?.inboxEmail).toBe("piyush@meetfigcel.com");
  });
});

it("holds local star, archive, and snooze, and does not call Gmail modify", async () => {
  await withClient(async (client) => {
    const stored = await addThread(client, {
      inbox: "divyam@usefigcel.com",
      gmailThread: "t-flags",
      subject: "Flag me",
      from: "ada@acme.test",
      to: "divyam@usefigcel.com",
      body: "flag body",
      rfc: "<flag@client.test>",
      gmailId: "m-flags",
      when: "2026-10-19T12:00:00.000Z",
    });
    await setMessageState(client, { messageId: stored.messageId, starred: true, read: true, actor: "test", source: "ui" });
    await setMessageState(client, {
      messageId: stored.messageId,
      snoozeUntil: new Date("2026-10-21T15:00:00.000Z"),
      actor: "test",
      source: "ui",
    });
    const flags = await client.query<{ is_starred: boolean; is_read: boolean; is_archived: boolean }>(
      "SELECT is_starred, is_read, is_archived FROM messages WHERE id = $1",
      [stored.messageId],
    );
    expect(flags.rows[0]).toMatchObject({ is_starred: true, is_read: true, is_archived: true });
    const jobs = await client.query<{ held_reason: string | null }>(
      "SELECT held_reason FROM gmail_mirror_jobs WHERE gmail_message_id = 'm-flags'",
    );
    expect(jobs.rows.length).toBeGreaterThan(0);
    expect(jobs.rows.every((row) => row.held_reason === "GMAIL_MIRROR_ENABLED is not true")).toBe(true);
    let fetches = 0;
    const held = await applyMirror(client, {
      enabled: false,
      getToken: async () => "nope",
      fetchImpl: async () => {
        fetches += 1;
        throw new Error("modify must not be called");
      },
    });
    expect(fetches).toBe(0);
    expect(held.applied).toBe(0);
    expect(held.held).toBeGreaterThan(0);

    await client.query("UPDATE messages SET snooze_until = now() - interval '1 minute' WHERE id = $1", [stored.messageId]);
    const released = await releaseSnoozed(client);
    expect(released).toBeGreaterThanOrEqual(1);
    const after = await client.query<{ snooze_until: Date | null; is_archived: boolean }>(
      "SELECT snooze_until, is_archived FROM messages WHERE id = $1",
      [stored.messageId],
    );
    expect(after.rows[0].snooze_until).toBeNull();
    expect(after.rows[0].is_archived).toBe(false);
  });
});

it("keeps a local star when a later sync would clear it", async () => {
  await withClient(async (client) => {
    await client.query("UPDATE inboxes SET history_id = NULL, status = 'active' WHERE email = 'divyam@usefigcel.com'");
    const unread = new FakeGmail("divyam@usefigcel.com", gmailMessage(["INBOX", "UNREAD"]));
    const first = await syncInbox(client, "divyam@usefigcel.com", unread, { limit: 1 });
    expect(first.ok).toBe(true);
    const message = await client.query<{ id: string }>(
      "SELECT id FROM messages WHERE gmail_message_id = 'm-keep'",
    );
    await setMessageState(client, { messageId: message.rows[0].id, starred: true, read: true, actor: "test", source: "system" });
    await client.query(
      "UPDATE messages SET labels = labels || '[\"LocalHold\"]'::jsonb WHERE gmail_message_id = 'm-keep'",
    );
    await client.query("UPDATE inboxes SET history_id = NULL WHERE email = 'divyam@usefigcel.com'");
    const cleared = new FakeGmail("divyam@usefigcel.com", gmailMessage(["INBOX", "UNREAD"]));
    await syncInbox(client, "divyam@usefigcel.com", cleared, { limit: 1 });
    const flags = await client.query<{ is_starred: boolean; is_read: boolean; labels: string[] }>(
      "SELECT is_starred, is_read, labels FROM messages WHERE gmail_message_id = 'm-keep'",
    );
    expect(flags.rows[0].is_starred).toBe(true);
    expect(flags.rows[0].is_read).toBe(true);
    expect(flags.rows[0].labels).toContain("LocalHold");
  });
});

it("stores a review draft and does not call the adapter when approval is off", async () => {
  await withClient(async (client) => {
    const contactId = await addContact(client, "ada@acme.test", "Acme");
    const campaign = await client.query<{ id: string }>(
      "INSERT INTO campaigns (name, status) VALUES ('Manual pilot', 'active') RETURNING id",
    );
    await client.query(
      "INSERT INTO enrollments (campaign_id, contact_id, status, unsub_token) VALUES ($1, $2, 'active', 'tok')",
      [campaign.rows[0].id, contactId],
    );
    const stored = await addThread(client, {
      inbox: "divyam@usefigcel.com",
      gmailThread: "t-reply",
      subject: "Intro",
      contactId,
      campaignId: campaign.rows[0].id,
      from: "ada@acme.test",
      to: "divyam@usefigcel.com",
      body: "Happy to chat",
      rfc: "<intro@client.test>",
      gmailId: "m-reply",
      when: "2026-10-19T16:00:00.000Z",
    });
    const { adapter, calls } = recorder();
    const result = await composeManual(client, {
      inboxEmail: "divyam@usefigcel.com",
      mode: "reply",
      sourceMessageId: stored.messageId,
      to: ["ada@acme.test"],
      subject: "Intro",
      html: `<script>alert(1)</script><p onclick="x">Thanks for the note</p>`,
      attachments: [{ filename: "note.txt", mimeType: "text/plain", contentBase64: Buffer.from("hi").toString("base64") }],
      actor: "test",
      source: "ui",
      sendingEnabled: true,
      sendMode: "live",
      adapter,
    });
    expect(result.outcome).toBe("drafted");
    expect(result.reason).toBe("approval is off");
    expect(calls).toHaveLength(0);
    expect(result.mime).toContain("In-Reply-To: <intro@client.test>");
    expect(result.mime).toContain("References: <intro@client.test>");
    expect(result.mime).toContain("Subject: Re: Intro");
    expect(result.mime).not.toContain("<script");
    expect(result.mime).not.toContain("onclick");
    expect(result.mime).toContain("note.txt");
    const draft = await client.query<{
      kind: string;
      in_reply_to: string;
      references_header: string;
      gmail_thread_id: string;
      body: string;
      html_body: string;
    }>("SELECT kind, in_reply_to, references_header, gmail_thread_id, body, html_body FROM review_drafts WHERE id = $1", [
      result.draftId,
    ]);
    expect(draft.rows[0].kind).toBe("manual");
    expect(draft.rows[0].in_reply_to).toBe("<intro@client.test>");
    expect(draft.rows[0].references_header).toContain("<intro@client.test>");
    expect(draft.rows[0].gmail_thread_id).toBe("t-reply");
    expect(draft.rows[0].body).toContain("Unsubscribe:");
    expect(draft.rows[0].html_body).not.toContain("script");
    expect((await client.query("SELECT COUNT(*)::int AS n FROM sends")).rows[0].n).toBe(0);
    const desk = await loadReviewDesk(client);
    expect(desk.drafts.some((item) => item.campaign === "Manual" && item.email === "ada@acme.test")).toBe(true);

    const blocked = recorder();
    await client.query(
      "INSERT INTO suppression (kind, value, reason, source) VALUES ('email', 'blocked@northwind.test', 'test', 'test')",
    );
    const skipped = await composeManual(client, {
      inboxEmail: "divyam@usefigcel.com",
      mode: "reply",
      sourceMessageId: stored.messageId,
      to: ["blocked@northwind.test"],
      subject: "Intro",
      html: "<p>no</p>",
      actor: "test",
      source: "ui",
      sendingEnabled: true,
      adapter: blocked.adapter,
    });
    expect(skipped.outcome).toBe("skipped");
    expect(blocked.calls).toHaveLength(0);
    expect((await client.query("SELECT COUNT(*)::int AS n FROM review_drafts WHERE to_addrs::text LIKE '%blocked@northwind.test%'")).rows[0].n).toBe(0);

    await expect(
      composeManual(client, {
        inboxEmail: "piyush@meetfigcel.com",
        mode: "reply",
        sourceMessageId: stored.messageId,
        to: ["ada@acme.test"],
        subject: "Intro",
        html: "<p>wrong inbox</p>",
        actor: "test",
        source: "ui",
      }),
    ).rejects.toThrow(/original inbox/);
  });
});

it("labels an interested reply and records an owner relabel", async () => {
  await withClient(async (client) => {
    const contactId = await addContact(client, "ada@acme.test", "Acme");
    const box = await inboxId(client, "divyam@usefigcel.com");
    const stored = await addThread(client, {
      inbox: "divyam@usefigcel.com",
      gmailThread: "t-class",
      subject: "Re: intro",
      contactId,
      from: "ada@acme.test",
      to: "divyam@usefigcel.com",
      body: "Happy to chat tomorrow",
      rfc: "<class@client.test>",
      gmailId: "m-class",
      when: "2026-10-19T17:00:00.000Z",
    });
    const stopped = await stopFromInbound(client, {
      inboxId: box,
      gmailMessageId: "m-class",
      fromEmail: "ada@acme.test",
      subject: "Re: intro",
      bodyText: "Happy to chat tomorrow",
    });
    expect(stopped.stopped).toBe(1);
    const labeled = await client.query<{ classification: string }>("SELECT classification FROM messages WHERE id = $1", [stored.messageId]);
    expect(labeled.rows[0].classification).toBe("interested");
    await relabelMessage(client, { messageId: stored.messageId, classification: "not_now", actor: "owner", source: "ui" });
    const audit = await client.query(
      "SELECT action, detail FROM audit_log WHERE action = 'classification.change' AND entity_id = $1",
      [stored.messageId],
    );
    expect(audit.rows[0].detail).toMatchObject({ from: "interested", to: "not_now" });
    const listed = await listThreads(client, {});
    expect(listed.find((row) => row.id === stored.threadId)?.classification).toBe("not_now");
  });
});
