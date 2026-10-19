import { SignInForm } from "@/components/sign-in-form";
import { localLoginEnabled } from "@/lib/auth/cookie";
import { LOGIN_DOMAINS } from "@/lib/auth/roles";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  google_not_configured:
    "Google sign-in is not configured. The client id is still TODO, so this button does not call Google.",
  not_invited: "That account has not been invited.",
  domain: "That domain is outside the five Figcel domains.",
  expired: "That sign-in expired. Start again.",
  csrf: "Refresh the page and try again.",
  local_off: "Email sign-in is off.",
  google: "Google did not complete sign-in.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.error;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const local = localLoginEnabled();
  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center px-4 py-16">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted">Figcel Outreach</p>
      <h1 className="font-display mt-2 text-4xl leading-tight">Sign in</h1>
      <p className="mt-4 text-base leading-relaxed text-muted">
        Only an account an admin has invited can open this desk. Google is the sign-in. Email sign-in stays off unless
        it is turned on in the environment.
      </p>
      {code && ERRORS[code] ? <p className="mt-4 text-sm text-rust">{ERRORS[code]}</p> : null}
      <a
        href="/api/auth/google"
        className="mt-8 inline-flex w-fit rounded-md bg-accent px-4 py-2.5 text-[15px] text-paper"
      >
        Continue with Google
      </a>
      <p className="mt-3 max-w-md text-sm leading-relaxed text-muted">
        <span className="font-mono text-ink">GOOGLE_OIDC_CLIENT_ID</span> and{" "}
        <span className="font-mono text-ink">GOOGLE_OIDC_CLIENT_SECRET</span> are TODO. Until both are set, this button
        returns here and does not contact Google.
      </p>
      <p className="mt-6 text-sm leading-relaxed text-muted">
        An admin can limit sign-in to {LOGIN_DOMAINS.join(", ")}. That setting is off until someone turns it on from
        Team.
      </p>
      {local ? (
        <SignInForm />
      ) : (
        <p className="mt-8 border-t border-line pt-6 text-sm text-muted">
          Password and magic-link sign-in are off. <span className="font-mono text-ink">LOCAL_LOGIN_ENABLED</span> is
          not true.
        </p>
      )}
    </main>
  );
}
