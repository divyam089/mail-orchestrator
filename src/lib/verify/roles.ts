/**
 * Mailbox names that are not a person.
 * RFC 2142 lists the required and common role boxes:
 * https://www.rfc-editor.org/rfc/rfc2142
 * The extra names are operational inboxes (noreply, billing, hr) used the same way.
 */

const RFC_2142 = [
  "info",
  "marketing",
  "sales",
  "support",
  "abuse",
  "noc",
  "security",
  "postmaster",
  "hostmaster",
  "webmaster",
  "www",
  "uucp",
  "ftp",
  "usenet",
  "news",
] as const;

const OPERATIONAL = [
  "admin",
  "administrator",
  "contact",
  "hello",
  "office",
  "team",
  "billing",
  "accounts",
  "accounting",
  "finance",
  "hr",
  "jobs",
  "careers",
  "press",
  "media",
  "newsletter",
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "privacy",
  "legal",
  "spam",
  "mailer-daemon",
  "root",
  "sysadmin",
  "it",
  "enquiries",
  "inquiries",
  "reception",
  "reservations",
  "bookings",
  "help",
] as const;

export const ROLE_LOCALS: ReadonlySet<string> = new Set<string>([...RFC_2142, ...OPERATIONAL]);

/** True when the mailbox (before any +tag) is a role name. Dots are kept. */
export function isRoleAccount(literalEmail: string): boolean {
  const at = literalEmail.indexOf("@");
  if (at <= 0) return false;
  let local = literalEmail.slice(0, at);
  const plus = local.indexOf("+");
  if (plus >= 0) local = local.slice(0, plus);
  return ROLE_LOCALS.has(local);
}
