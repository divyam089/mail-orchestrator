export type VerificationStatus = "valid" | "risky" | "invalid" | "unknown" | "error";

export type VerificationResult = {
  provider: string;
  status: VerificationStatus;
  reason: string;
};

/**
 * Swap point for a verification vendor. None is chosen.
 * ZeroBounce, NeverBounce, and MillionVerifier are candidates only.
 */
export interface VerificationAdapter {
  readonly provider: string;
  verify(email: string): Promise<VerificationResult>;
}

export class TodoVerificationAdapter implements VerificationAdapter {
  readonly provider = "TODO: verification provider";

  async verify(email: string): Promise<VerificationResult> {
    return {
      provider: this.provider,
      status: "unknown",
      reason: `TODO: verification provider has not checked ${email}`,
    };
  }
}
