import { expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DashboardView } from "@/components/dashboard-view";
import { toCsv } from "@/lib/dashboard/csv";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  const base: DashboardSnapshot = {
    from: "2026-10-19",
    to: "2026-10-19",
    today: "2026-10-19",
    approvalMode: "review",
    totals: {
      sent: 0,
      delivered: 0,
      hardBounces: 0,
      softBounces: 0,
      replies: 0,
      positiveReplies: 0,
      unsubscribes: 0,
      complaints: null,
    },
    tracking: {
      opens: null,
      clicks: null,
      note: "Unreliable. Apple Mail Privacy Protection inflates opens. Shown only when that campaign has tracking on.",
    },
    queue: { ready: null, processing: null, reviewDrafts: 0 },
    caps: {
      fleetUsed: 0,
      fleetCap: 405,
      fleetHardMax: 405,
      perInboxHardMax: 27,
      ramp: "3d→9, 4d→18, restd→27",
      inboxes: [{ email: "divyam@usefigcel.com", used: 0, cap: 9, rampDay: 1 }],
    },
    byInbox: [
      {
        email: "divyam@usefigcel.com",
        sent: 0,
        delivered: 0,
        hardBounces: 0,
        softBounces: 0,
        replies: 0,
        positiveReplies: 0,
        unsubscribes: 0,
      },
    ],
    byCampaign: [],
    byDay: [],
    funnel: [],
    health: [
      {
        email: "divyam@usefigcel.com",
        status: "not_connected",
        pause: null,
        bounceRate: "no data yet",
        lastSync: null,
        seedPlacement: "no data yet",
        warmup: "TODO: warmup provider",
      },
      {
        email: "piyush@usefigcel.com",
        status: "paused",
        pause: "hard_bounce · stop fired",
        bounceRate: "no data yet",
        lastSync: null,
        seedPlacement: "Seed-test estimate 80% inbox / 20% spam at 2026-10-19 14:00 UTC. Not real placement.",
        warmup: "TODO: warmup provider",
      },
    ],
    unsubSync: "no unsub sync yet",
    alerts: { disconnects: [], pauses: [], sync: [], failedJobs: [] },
  };
  return { ...base, ...overrides };
}

function render(data: DashboardSnapshot) {
  return renderToStaticMarkup(createElement(DashboardView, { data, live: "live" }));
}

it("shows empty ledger states without inventing a complaint or an open", () => {
  const html = render(snapshot());
  expect(html).toContain("no data yet");
  expect(html).toContain("no source");
  expect(html).toContain("tracking off");
  expect(html).toContain("Review queue");
  expect(html).toContain("TODO: warmup provider");
  expect(html).toContain("Seed-test estimate");
  expect(html).toContain("Not real placement");
  expect(html).toContain("Apple");
  expect(html).toContain("unavailable");
  expect(html).toContain("27");
  expect(html).toContain("405");
  expect(html).toContain("/api/dashboard/export?view=summary");
  expect(html).toContain("/api/dashboard/export?view=funnel");
  expect(html).toContain("/api/dashboard/export?view=alerts");
  expect(html).toContain("data-live=\"live\"");
});

it("labels tracked opens as unreliable", () => {
  const html = render(
    snapshot({
      tracking: { opens: 2, clicks: 1, note: "Unreliable. Apple Mail Privacy Protection inflates opens." },
      byCampaign: [
        {
          campaign: "Sample: tracked",
          sent: 2,
          delivered: 2,
          hardBounces: 0,
          softBounces: 0,
          replies: 0,
          positiveReplies: 0,
          unsubscribes: 0,
          opens: 2,
          clicks: 1,
          tracking: "on · unreliable (Apple MPP)",
        },
      ],
    }),
  );
  expect(html).toContain("Unreliable");
  expect(html).toContain("Apple");
  expect(html).toContain(">2<");
});

it("escapes spreadsheet formulas in CSV cells", () => {
  expect(toCsv(["a"], [["=1+1"]])).toBe("a\r\n'=1+1\r\n");
});
