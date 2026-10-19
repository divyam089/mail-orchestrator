export type ShortcutAction =
  | "next"
  | "previous"
  | "reply"
  | "reply_all"
  | "forward"
  | "archive"
  | "star"
  | "search"
  | "help";

export function shortcutFor(key: string, typing: boolean): ShortcutAction | null {
  if (key === "Escape") return "help";
  if (typing) return null;
  switch (key) {
    case "j":
      return "next";
    case "k":
      return "previous";
    case "r":
      return "reply";
    case "a":
      return "reply_all";
    case "f":
      return "forward";
    case "e":
      return "archive";
    case "s":
      return "star";
    case "/":
      return "search";
    case "?":
      return "help";
    default:
      return null;
  }
}

export type PaneThread = { id: string; contactId: string | null };

/** Selecting a row swaps the message and the context contact together. */
export function threadAt(threads: readonly PaneThread[], index: number): PaneThread | null {
  if (threads.length === 0) return null;
  const bounded = Math.max(0, Math.min(index, threads.length - 1));
  return threads[bounded] ?? null;
}

export function moveSelection(length: number, index: number, delta: number): number {
  if (length === 0) return 0;
  return Math.max(0, Math.min(length - 1, index + delta));
}
