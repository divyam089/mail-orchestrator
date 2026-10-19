import { describe, expect, it } from "vitest";
import {
  anySendingPermitted,
  autoSendPermitted,
  isUnset,
  readSendMode,
  readSendingEnabled,
  sendingBlockers,
} from "@/lib/gates";

const open = {
  sendingEnabled: true,
  legalName: "Figcel Inc.",
  postalAddress: "1 Market Street, San Francisco, CA 94105",
};

describe("sending gates", () => {
  it("defaults the kill switch off unless the value is exactly true", () => {
    expect(readSendingEnabled({})).toBe(false);
    expect(readSendingEnabled({ SENDING_ENABLED: "false" })).toBe(false);
    expect(readSendingEnabled({ SENDING_ENABLED: "yes" })).toBe(false);
    expect(readSendingEnabled({ SENDING_ENABLED: "TRUE" })).toBe(true);
    expect(readSendMode({})).toBe("dry-run");
    expect(readSendMode({ SEND_MODE: "live" })).toBe("live");
    expect(readSendMode({ SEND_MODE: "sometimes" })).toBe("dry-run");
  });

  it("blocks while the kill switch is off or legal fields are TODO", () => {
    expect(isUnset("TODO: legal name")).toBe(true);
    expect(isUnset("BLOCKED: physical postal address")).toBe(true);
    expect(isUnset("PLACEHOLDER")).toBe(true);
    expect(isUnset("  ")).toBe(true);
    expect(isUnset("Figcel Inc.")).toBe(false);

    expect(
      sendingBlockers({
        sendingEnabled: false,
        legalName: "TODO: legal name",
        postalAddress: "TODO: postal address",
      }),
    ).toEqual([
      "SENDING_ENABLED is not exactly true",
      "TODO: legal name",
      "TODO: postal address",
    ]);
    expect(sendingBlockers({ ...open, postalAddress: "TODO: postal address" })).toEqual([
      "TODO: postal address",
    ]);
    expect(sendingBlockers({ ...open, legalName: "BLOCKED: name" })).toEqual(["TODO: legal name"]);
    expect(sendingBlockers(open)).toEqual([]);
  });

  it("keeps auto-send off while approval is review, even if the other gates are clear", () => {
    expect(anySendingPermitted(open)).toBe(true);
    expect(anySendingPermitted({ ...open, sendingEnabled: false })).toBe(false);
    expect(autoSendPermitted({ ...open, approvalMode: "review" })).toBe(false);
    expect(autoSendPermitted({ ...open, approvalMode: "auto" })).toBe(true);
    expect(
      autoSendPermitted({ ...open, approvalMode: "auto", legalName: "TODO: legal name" }),
    ).toBe(false);
  });
});
