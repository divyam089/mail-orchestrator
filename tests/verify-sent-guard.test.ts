import { execFile } from "node:child_process";
import { expect, it } from "vitest";

it("refuses the Sent-folder check before any Gmail import", async () => {
  const result = await new Promise<{ code: number; stderr: string; stdout: string }>((resolve) => {
    execFile(
      "npx",
      ["tsx", "scripts/verify-sent-thread.ts", "--confirm-seed-send", "--inbox", "divyam@usefigcel.com", "--seed", "seed@example.com", "--thread", "00000000-0000-0000-0000-000000000000"],
      {
        cwd: process.cwd(),
        env: { ...process.env, SENDING_ENABLED: "false", SEND_MODE: "dry-run", GMAIL_MIRROR_ENABLED: "false" },
      },
      (error, stdout, stderr) => {
        const code = error && "code" in error && typeof error.code === "number" ? error.code : 0;
        resolve({ code, stderr: String(stderr), stdout: String(stdout) });
      },
    );
  });
  expect(result.code).toBe(2);
  expect(result.stderr).toMatch(/refused/);
  expect(result.stderr).toMatch(/No Gmail request was made/);
  expect(result.stdout).not.toMatch(/messages\/send/);
});
