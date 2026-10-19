import { readFileSync } from "node:fs";
import { createGmailReadClient } from "@/lib/mail/gmail-rest";
import { requireServiceAccountKeyPath } from "@/lib/mail/key-path";
import { GMAIL_SCOPES } from "@/lib/mail/quota";
import type { GmailReadClient } from "@/lib/mail/types";

export type GmailClientFactory = (inboxEmail: string) => Promise<GmailReadClient>;

/**
 * One service account, domain-wide delegation, impersonating each inbox.
 * Scopes match the grant already authorized on the five Workspace tenants.
 * gmail.send is on the token so the grant matches. This factory never calls
 * messages.send. The mailbox send() method throws.
 */
export async function serviceAccountClientFactory(keyPath = requireServiceAccountKeyPath()): Promise<GmailClientFactory> {
  const parsed = JSON.parse(readFileSync(keyPath, "utf8")) as { client_email?: string; private_key?: string };
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("Service account JSON is missing client_email or private_key");
  }
  const { JWT } = await import("google-auth-library");
  const clientEmail = parsed.client_email;
  const privateKey = parsed.private_key;
  return async (inboxEmail: string) => {
    const jwt = new JWT({
      email: clientEmail,
      key: privateKey,
      scopes: [...GMAIL_SCOPES],
      subject: inboxEmail,
    });
    return createGmailReadClient({
      getToken: async () => {
        const token = await jwt.getAccessToken();
        if (!token.token) throw new Error(`Google auth returned no access token for ${inboxEmail}`);
        return token.token;
      },
    });
  };
}
