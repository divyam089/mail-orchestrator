import { describe, expect, it } from "vitest";
import { literalEmail, normalizeEmail } from "@/lib/email/normalize";
import { EMAIL_CASES } from "./email-cases";

describe("normalizeEmail", () => {
  it.each(EMAIL_CASES)("$input", ({ input, literal, normalized }) => {
    expect(literalEmail(input)).toBe(literal);
    expect(normalizeEmail(input)).toBe(normalized);
  });

  it("rejects null and non-strings", () => {
    expect(normalizeEmail(null)).toBeNull();
    expect(literalEmail(undefined)).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });

  it("does not fold dots on Workspace domains", () => {
    expect(normalizeEmail("divyam.maru@usefigcel.com")).not.toBe(
      normalizeEmail("divyammaru@usefigcel.com"),
    );
  });
});
