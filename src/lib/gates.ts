/**
 * Nothing leaves the building while any blocker is set.
 * Approval "review" is a separate switch: it queues drafts instead of auto-sending.
 * The kill switch and the TODO legal fields block approved sends too.
 */

export type ApprovalMode = "review" | "auto";

export function isUnset(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  const upper = trimmed.toUpperCase();
  return upper.includes("TODO:") || upper.includes("BLOCKED") || upper.includes("PLACEHOLDER");
}

export function readSendingEnabled(env?: { SENDING_ENABLED?: string }): boolean {
  const source = env ?? process.env;
  return (source.SENDING_ENABLED ?? "false").trim().toLowerCase() === "true";
}

export function readSendMode(env?: { SEND_MODE?: string }): "dry-run" | "seed-only" | "live" {
  const source = env ?? process.env;
  const mode = (source.SEND_MODE ?? "dry-run").trim().toLowerCase();
  if (mode === "seed-only" || mode === "live") return mode;
  return "dry-run";
}

export function sendingBlockers(input: {
  sendingEnabled: boolean;
  legalName: string | null;
  postalAddress: string | null;
}): string[] {
  const blockers: string[] = [];
  if (!input.sendingEnabled) blockers.push("SENDING_ENABLED is not exactly true");
  if (isUnset(input.legalName)) blockers.push("TODO: legal name");
  if (isUnset(input.postalAddress)) blockers.push("TODO: postal address");
  return blockers;
}

/** Human approve-and-send is still refused while the kill switch or legal fields are open. */
export function anySendingPermitted(input: {
  sendingEnabled: boolean;
  legalName: string | null;
  postalAddress: string | null;
}): boolean {
  return sendingBlockers(input).length === 0;
}

/** Scheduled auto-send also requires the approval toggle to be ON. */
export function autoSendPermitted(input: {
  sendingEnabled: boolean;
  legalName: string | null;
  postalAddress: string | null;
  approvalMode: ApprovalMode;
}): boolean {
  return anySendingPermitted(input) && input.approvalMode === "auto";
}
