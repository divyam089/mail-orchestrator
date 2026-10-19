import { expect, it } from "vitest";
import { htmlToText, sanitizeHtml } from "@/lib/mail/sanitize";

it("strips scripts, event handlers, and javascript urls", () => {
  const clean = sanitizeHtml(
    `<script>alert(1)</script><p onclick="steal()">Hi <a href="javascript:alert(1)">x</a> <a href="https://figcel.example/a">ok</a></p>`,
  );
  expect(clean).not.toContain("script");
  expect(clean).not.toContain("onclick");
  expect(clean).not.toContain("javascript:");
  expect(clean).toContain('href="https://figcel.example/a"');
  expect(clean).toContain("<p>");
  expect(htmlToText(clean)).toContain("Hi");
  expect(htmlToText("<p>Line</p><p>Two</p>")).toBe("Line\nTwo");
});

it("drops comments and data urls", () => {
  const clean = sanitizeHtml(`<!-- <script>nope</script> --><a href="data:text/html,hi">bad</a><em>kept</em>`);
  expect(clean).not.toContain("script");
  expect(clean).not.toContain("data:");
  expect(clean).toContain("<em>kept</em>");
});
