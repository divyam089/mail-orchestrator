import { expect, it } from "vitest";
import { TodoReplyModel, classifyByRules, classifyReply } from "@/lib/mail/classify";

it("classifies with rules and leaves the model as a TODO adapter", () => {
  expect(classifyByRules({ body: "Please unsubscribe me" })).toBe("unsubscribe");
  expect(classifyByRules({ subject: "Automatic reply", body: "I am interested" })).toBe("ooo");
  expect(classifyByRules({ body: "Not interested, thanks" })).toBe("not_interested");
  expect(classifyByRules({ body: "Not now, next quarter" })).toBe("not_now");
  expect(classifyByRules({ body: "Happy to chat next week" })).toBe("interested");
  expect(classifyByRules({ body: "Received, thanks" })).toBeNull();
  const model = new TodoReplyModel();
  expect(model.name).toBe("TODO: reply model");
  expect(model.classify({ body: "anything" })).toBeNull();
  expect(classifyReply({ body: "Received, thanks" }, model)).toBeNull();
  expect(classifyReply({ body: "Let's talk" }, model)).toBe("interested");
});
