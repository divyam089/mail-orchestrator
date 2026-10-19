import { describe, expect, it } from "vitest";
import { mapCsv, parsePaste } from "@/lib/contacts/parse-leads";

describe("lead parsers", () => {
  it("maps CSV columns, quoted commas, and custom variables", () => {
    const csv = 'Email,First,"Company, Inc",Plan\r\n"Doe, Ada" <ada@acme.test>,Ada,"Analytical, Inc",gold\n';
    const records = mapCsv(csv, {
      email: "email",
      firstName: "First",
      company: "Company, Inc",
      custom: { plan: "Plan" },
    });
    expect(records).toEqual([
      {
        email: "Doe, Ada <ada@acme.test>",
        firstName: "Ada",
        lastName: null,
        company: "Analytical, Inc",
        title: null,
        timezone: null,
        custom: { plan: "gold" },
        lineNumber: 2,
      },
    ]);
  });

  it("reads a paste of bare addresses and display names", () => {
    const records = parsePaste("\n# comment\nJane Doe <jane.doe+sales@gmail.com>\njane@acme.test\n");
    expect(records.map((record) => record.email)).toEqual(["jane.doe+sales@gmail.com", "jane@acme.test"]);
    expect(records[0]).toMatchObject({ firstName: "Jane", lastName: "Doe", lineNumber: 3 });
    expect(records[1].lineNumber).toBe(4);
  });

  it("rejects a CSV that has no email column", () => {
    expect(() => mapCsv("name\nAda\n", { email: "email" })).toThrow(/no "email" column/);
  });
});
