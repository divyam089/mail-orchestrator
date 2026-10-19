import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { loadStatus } from "@/lib/status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const gate = await guard(request, "viewer");
  if ("response" in gate) return gate.response;
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
