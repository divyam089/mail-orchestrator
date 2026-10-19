export type ReplyClass = "interested" | "not_now" | "not_interested" | "ooo" | "unsubscribe";

export const REPLY_CLASSES: ReplyClass[] = ["interested", "not_now", "not_interested", "ooo", "unsubscribe"];

export type ClassifyInput = { subject?: string | null; body?: string | null };

/** Swappable model. No vendor is configured. */
export interface ReplyModel {
  readonly name: string;
  classify(input: ClassifyInput): ReplyClass | null;
}

export class TodoReplyModel implements ReplyModel {
  readonly name = "TODO: reply model";

  classify(input: ClassifyInput): ReplyClass | null {
    void input;
    return null;
  }
}

const RULES: { pattern: RegExp; label: ReplyClass }[] = [
  { pattern: /\b(unsubscribe|remove me|opt[\s-]?out)\b/i, label: "unsubscribe" },
  { pattern: /\b(out of office|automatic reply|auto-reply|autoreply|away from the office)\b/i, label: "ooo" },
  { pattern: /\b(not interested|no thanks|not a fit|stop emailing)\b/i, label: "not_interested" },
  { pattern: /\b(not now|next quarter|circle back|maybe later|busy right now)\b/i, label: "not_now" },
  { pattern: /\b(interested|let's talk|lets talk|book a time|sounds good|happy to chat)\b/i, label: "interested" },
];

export function classifyByRules(input: ClassifyInput): ReplyClass | null {
  const text = `${input.subject ?? ""}\n${input.body ?? ""}`;
  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.label;
  }
  return null;
}

/** Rules first. The model is only asked when the rules do not match. */
export function classifyReply(input: ClassifyInput, model: ReplyModel = new TodoReplyModel()): ReplyClass | null {
  return classifyByRules(input) ?? model.classify(input);
}
