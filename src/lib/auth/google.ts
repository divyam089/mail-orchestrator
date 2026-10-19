import { OAuth2Client } from "google-auth-library";
import { AuthError } from "@/lib/auth/errors";

export type OidcIdentity = {
  email: string;
  emailVerified: boolean;
  sub: string;
  name: string | null;
  nonce: string;
};

export type OidcProvider = {
  configured(): boolean;
  authorizationUrl(input: { state: string; nonce: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; redirectUri: string; nonce: string }): Promise<OidcIdentity>;
};

function clientId(): string {
  return process.env.GOOGLE_OIDC_CLIENT_ID?.trim() ?? "";
}

function clientSecret(): string {
  return process.env.GOOGLE_OIDC_CLIENT_SECRET?.trim() ?? "";
}

const realProvider: OidcProvider = {
  configured() {
    return Boolean(clientId() && clientSecret());
  },
  authorizationUrl({ state, nonce, redirectUri }) {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.searchParams.set("client_id", clientId());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("prompt", "select_account");
    return url.toString();
  },
  async exchangeCode({ code, redirectUri, nonce }) {
    if (!clientId() || !clientSecret()) {
      throw new AuthError(501, "validation", "TODO: GOOGLE_OIDC_CLIENT_ID and GOOGLE_OIDC_CLIENT_SECRET");
    }
    const client = new OAuth2Client(clientId(), clientSecret(), redirectUri);
    const exchanged = await client.getToken(code);
    const idToken = exchanged.tokens.id_token;
    if (!idToken) throw new AuthError(401, "unauthorized", "Google did not return an identity token");
    const ticket = await client.verifyIdToken({ idToken, audience: clientId() });
    const payload = ticket.getPayload();
    if (!payload?.email || !payload.sub) throw new AuthError(401, "unauthorized", "Google account has no email");
    if (payload.nonce !== nonce) throw new AuthError(401, "unauthorized", "Sign-in nonce did not match");
    return {
      email: payload.email,
      emailVerified: payload.email_verified === true,
      sub: payload.sub,
      name: payload.name ?? null,
      nonce,
    };
  },
};

let provider: OidcProvider = realProvider;

export function setOidcProvider(next: OidcProvider | null): void {
  provider = next ?? realProvider;
}

export function oidcProvider(): OidcProvider {
  return provider;
}
