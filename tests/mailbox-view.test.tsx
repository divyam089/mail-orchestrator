import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MailboxView } from "@/components/mailbox-view";
import type { ThreadDetail, ThreadSummary } from "@/lib/mail/mailbox";

const filters = { q: "", inboxId: "", view: "inbox", label: "", campaignId: "" };

function summary(id: string, subject: string, contact: string): ThreadSummary {
  return {
    id,
    subject,
    snippet: subject,
    inboxEmail: "divyam@usefigcel.com",
    inboxId: "inbox",
    when: null,
    unread: true,
    starred: false,
    classification: id === "thread-b" ? "interested" : null,
    contactId: id,
    contactEmail: contact,
    campaign: null,
  };
}

function detail(id: string, subject: string, contact: string, company: string): ThreadDetail {
  return {
    id,
    subject,
    gmailThreadId: `g-${id}`,
    inboxEmail: "divyam@usefigcel.com",
    inboxId: "inbox",
    messages: [
      {
        id: `m-${id}`,
        fromEmail: contact,
        fromName: company,
        to: [{ email: "divyam@usefigcel.com" }],
        cc: [],
        subject,
        bodyText: `Body of ${subject}`,
        bodyHtml: null,
        direction: "in",
        at: "2026-10-19 12:00 UTC",
        isRead: false,
        isStarred: false,
        classification: null,
        inboxEmail: "divyam@usefigcel.com",
        rfcMessageId: `<${id}@client.test>`,
        attachments: [],
      },
    ],
    context: {
      contact: {
        id: `c-${id}`,
        email: contact,
        firstName: company,
        lastName: null,
        company,
        title: null,
        timezone: "America/New_York",
        verification: "valid",
      },
      campaign: null,
      timeline: [],
      verification: { status: "valid", provider: "TODO: verification provider", at: null },
      inbox: { email: "divyam@usefigcel.com", status: "active", cap: 9, sentToday: 0, pause: null },
      otherThreads: [],
      notes: [],
      tags: [],
    },
  };
}

function render(selected: ThreadDetail) {
  return renderToStaticMarkup(
    createElement(MailboxView, {
      threads: [summary("thread-a", "Ada at Acme", "ada@acme.test"), summary("thread-b", "Bea at Northwind", "bea@northwind.test")],
      selectedId: selected.id,
      detail: selected,
      inboxes: [{ id: "inbox", email: "divyam@usefigcel.com" }],
      campaigns: [],
      labels: [],
      templates: [],
      filters,
      approvalMode: "review",
      pane: "list",
      helpOpen: false,
      compose: null,
      notice: null,
      busy: false,
    }),
  );
}

it("swaps the message and the context contact together", () => {
  const ada = render(detail("thread-a", "Ada at Acme", "ada@acme.test", "Acme"));
  const bea = render(detail("thread-b", "Bea at Northwind", "bea@northwind.test", "Northwind"));
  expect(ada).toContain('data-contact="ada@acme.test"');
  expect(ada).toContain('data-subject="Ada at Acme"');
  expect(ada).toContain("Body of Ada at Acme");
  expect(ada).not.toContain("Body of Bea at Northwind");
  expect(bea).toContain('data-contact="bea@northwind.test"');
  expect(bea).toContain('data-subject="Bea at Northwind"');
  expect(bea).toContain("Body of Bea at Northwind");
  expect(bea).not.toContain("Body of Ada at Acme");
  expect(bea).toContain("Interested");
  expect(ada).toContain("Approval is off");
  expect(ada).toContain("divyam@usefigcel.com");
});

it("renders the shortcut overlay", () => {
  const html = renderToStaticMarkup(
    createElement(MailboxView, {
      threads: [],
      selectedId: null,
      detail: null,
      inboxes: [],
      campaigns: [],
      labels: [],
      templates: [],
      filters,
      approvalMode: "review",
      pane: "list",
      helpOpen: true,
      compose: null,
      notice: null,
      busy: false,
    }),
  );
  expect(html).toContain("Shortcuts");
  expect(html).toContain("reply all");
  expect(html).toContain("No mail in this view");
});
