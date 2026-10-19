import type { MxResult } from "@/lib/verify/dns";
import type { VerificationResult, VerificationStatus } from "@/lib/verify/adapter";

export type ContactVerdict = "valid" | "risky" | "invalid" | "unknown";

export type Verdict = {
  status: ContactVerdict;
  reason: string;
  providerStatus: VerificationStatus | null;
};

/**
 * Local checks outrank a vendor "valid".
 * With no provider, an MX pass stays unknown unless treatMxPassAsValid is set.
 */
export function decideVerification(input: {
  mx: MxResult;
  role: boolean;
  disposable: boolean;
  provider: VerificationResult | null;
  treatMxPassAsValid: boolean;
}): Verdict {
  if (input.mx.state === "fail") {
    const reason = input.mx.via === "null-mx" ? "Null MX (RFC 7505): the domain does not accept mail" : "No MX and no A or AAAA record (RFC 5321)";
    return { status: "invalid", reason, providerStatus: input.provider?.status ?? null };
  }
  if (input.provider?.status === "invalid") {
    return { status: "invalid", reason: input.provider.reason, providerStatus: "invalid" };
  }
  if (input.role) {
    return { status: "risky", reason: "Role account", providerStatus: input.provider?.status ?? null };
  }
  if (input.disposable) {
    return { status: "risky", reason: "Disposable domain", providerStatus: input.provider?.status ?? null };
  }
  if (input.mx.state === "unknown") {
    const reason = input.mx.via === "timeout" ? "DNS lookup timed out" : "DNS lookup failed";
    return { status: "unknown", reason, providerStatus: input.provider?.status ?? null };
  }
  if (input.provider) {
    if (input.provider.status === "risky") {
      return { status: "risky", reason: input.provider.reason, providerStatus: "risky" };
    }
    if (input.provider.status === "valid") {
      return { status: "valid", reason: input.provider.reason, providerStatus: "valid" };
    }
    return {
      status: "unknown",
      reason: input.provider.reason,
      providerStatus: input.provider.status,
    };
  }
  if (input.treatMxPassAsValid) {
    return {
      status: "valid",
      reason: "MX pass treated as valid by the owner policy. No verification provider is configured.",
      providerStatus: null,
    };
  }
  return {
    status: "unknown",
    reason: "MX pass. No verification provider is configured, so this address is not valid.",
    providerStatus: null,
  };
}
