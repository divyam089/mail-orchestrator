import { describe, expect, it } from "vitest";
import { requireServiceAccountKeyPath } from "@/lib/mail/key-path";

describe("service account key path", () => {
  it("tells the operator to set GMAIL_SA_KEY_PATH when it is empty", () => {
    expect(() => requireServiceAccountKeyPath({})).toThrow(/GMAIL_SA_KEY_PATH is not set/);
    expect(() => requireServiceAccountKeyPath({ GMAIL_SA_KEY_PATH: "   " })).toThrow(/npm run inbox:check/);
  });

  it("refuses a path that is not on this machine", () => {
    expect(() =>
      requireServiceAccountKeyPath({ GMAIL_SA_KEY_PATH: "/tmp/figcel-sa-key-does-not-exist.json" }),
    ).toThrow(/does not exist: \/tmp\/figcel-sa-key-does-not-exist\.json/);
  });
});
