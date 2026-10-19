import { describe, expect, it } from "vitest";
import { INBOXES, WORKSPACE_DOMAINS, domainOf } from "@/lib/inboxes";

describe("inbox roster", () => {
  it("lists 15 inboxes, three on each of the five Workspace domains", () => {
    expect(INBOXES).toHaveLength(15);
    expect(new Set(INBOXES.map((inbox) => inbox.email)).size).toBe(15);
    const counts = new Map<string, number>();
    for (const inbox of INBOXES) {
      expect(inbox.email).toBe(inbox.email.toLowerCase());
      expect(inbox.senderName.trim().length).toBeGreaterThan(0);
      const domain = domainOf(inbox.email);
      counts.set(domain, (counts.get(domain) ?? 0) + 1);
    }
    expect([...counts.keys()].sort()).toEqual([...WORKSPACE_DOMAINS].sort());
    expect([...counts.values()].every((count) => count === 3)).toBe(true);
  });
});
