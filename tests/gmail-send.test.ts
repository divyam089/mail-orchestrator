import { describe, expect, it } from "vitest";
import { postGmailSend } from "@/lib/mail/gmail-send";

describe("gmail send path", () => {
  it("posts messages.send and does not use the network", async () => {
    const calls: { url: string; method: string; body: string }[] = [];
    const result = await postGmailSend({
      getToken: async () => "test-token",
      raw: "cmF3",
      threadId: "thread-1",
      fetchImpl: async (url, init) => {
        calls.push({ url, method: init.method, body: init.body });
        return {
          status: 200,
          async text() {
            return JSON.stringify({ id: "msg-1", threadId: "thread-1" });
          },
        };
      },
    });
    expect(result).toEqual({ id: "msg-1", threadId: "thread-1" });
    expect(calls).toEqual([
      {
        url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        method: "POST",
        body: JSON.stringify({ raw: "cmF3", threadId: "thread-1" }),
      },
    ]);
  });
});
