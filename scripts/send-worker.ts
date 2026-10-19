import { config } from "dotenv";
import { readSendingEnabled } from "@/lib/gates";

config({ quiet: true });

if (!readSendingEnabled()) {
  console.log("SENDING_ENABLED is not true. Send worker exited without calling Gmail.");
  process.exit(0);
}

const { startGmailWorker } = await import("@/lib/send/gmail-worker");
await startGmailWorker();
