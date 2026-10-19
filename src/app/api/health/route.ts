import { NextResponse } from "next/server";
import { loadStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const status = await loadStatus();
  return NextResponse.json({
    ok: status.ok && status.postgres === "up" && status.redis === "up",
    postgres: status.postgres,
    redis: status.redis,
    migration: status.migrationVersion,
    inboxes: status.inboxes.length,
    approvalMode: status.approvalMode,
    sendingEnabled: status.sendingEnabled,
    sendMode: status.sendMode,
    blockers: status.blockers,
    anySendingPermitted: status.anySendingPermitted,
    autoSendPermitted: status.autoSendPermitted,
    gmailKeyConfigured: status.gmailKeyConfigured,
    verificationProvider: status.verificationProvider,
    treatMxPassAsValid: status.treatMxPassAsValid,
    error: status.error,
  });
}
