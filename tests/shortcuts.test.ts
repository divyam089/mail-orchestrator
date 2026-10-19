import { expect, it } from "vitest";
import { moveSelection, shortcutFor, threadAt } from "@/lib/mail/shortcuts";

it("maps the mailbox keys and ignores them while typing", () => {
  expect(shortcutFor("j", false)).toBe("next");
  expect(shortcutFor("k", false)).toBe("previous");
  expect(shortcutFor("r", false)).toBe("reply");
  expect(shortcutFor("a", false)).toBe("reply_all");
  expect(shortcutFor("f", false)).toBe("forward");
  expect(shortcutFor("e", false)).toBe("archive");
  expect(shortcutFor("s", false)).toBe("star");
  expect(shortcutFor("/", false)).toBe("search");
  expect(shortcutFor("?", false)).toBe("help");
  expect(shortcutFor("j", true)).toBeNull();
  expect(shortcutFor("Escape", true)).toBe("help");
  expect(shortcutFor("x", false)).toBeNull();
});

it("moves the selection and swaps the thread under the panes", () => {
  const threads = [
    { id: "a", contactId: "ada" },
    { id: "b", contactId: "bea" },
  ];
  expect(moveSelection(2, 0, 1)).toBe(1);
  expect(moveSelection(2, 0, -1)).toBe(0);
  expect(moveSelection(0, 0, 1)).toBe(0);
  expect(threadAt(threads, 0)?.contactId).toBe("ada");
  expect(threadAt(threads, 1)?.contactId).toBe("bea");
  expect(threadAt(threads, 9)?.id).toBe("b");
});
