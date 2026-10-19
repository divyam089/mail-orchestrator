/**
 * Canonical address for dedupe.
 *
 * Every address is trimmed and lowercased. Dots and +tags are removed only for
 * gmail.com and googlemail.com (googlemail.com folds to gmail.com), which is
 * where Gmail itself ignores them. Other domains, including our Workspace
 * domains, keep dots and +tags: those characters are significant on most hosts,
 * and we cannot know from the address alone that a domain is hosted on Gmail.
 */

const LOCAL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/;
const DOMAIN_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

function trimAscii(value: string): string {
  return value.replace(/^[ \t\r\n\f\v]+|[ \t\r\n\f\v]+$/g, "");
}

function extractAddress(value: string): string {
  const match = value.match(/<([^<>]+)>\s*$/);
  return match ? trimAscii(match[1]) : value;
}

/** Lowercased address with display names removed, before Gmail folding. */
export function literalEmail(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  let address = extractAddress(trimAscii(input));
  if (!address || /[^\x00-\x7F]/.test(address)) return null;
  address = address.toLowerCase();
  if (address.endsWith(".")) address = address.slice(0, -1);
  if (!address || address.length > 254 || /[ \t\r\n\f\v]/.test(address)) return null;

  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!local || !domain || local.length > 64 || domain.length > 253) return null;
  if (!LOCAL_RE.test(local) || !DOMAIN_RE.test(domain)) return null;
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2) return null;
  return `${local}@${domain}`;
}

/** Address used as the global contact key. Null when the input is not an email. */
export function normalizeEmail(input: string | null | undefined): string | null {
  const literal = literalEmail(input);
  if (!literal) return null;
  const at = literal.indexOf("@");
  let local = literal.slice(0, at);
  let domain = literal.slice(at + 1);

  if (GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll(".", "");
    if (!local || !/^[a-z0-9]+$/.test(local)) return null;
    domain = "gmail.com";
    return `${local}@${domain}`;
  }

  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return literal;
}
