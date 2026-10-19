import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Disposable domains from disposable-email-domains/disposable-email-domains.
 * Commit b63df8b431f37ef0b22524f9cae2e86c7114a9de, retrieved 2026-10-19.
 * License: CC0 1.0 Universal. See vendor/SOURCE.txt.
 */

let domains: Set<string> | null = null;

export function loadDisposableDomains(): Set<string> {
  if (domains) return domains;
  const file = path.join(process.cwd(), "src/lib/verify/vendor/disposable_email_blocklist.conf");
  const text = readFileSync(file, "utf8");
  const set = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const domain = line.trim().toLowerCase();
    if (!domain || domain.startsWith("#")) continue;
    set.add(domain);
  }
  domains = set;
  return set;
}

/** True when the domain or a parent (not the TLD alone) is on the vendored list. */
export function isDisposableDomain(domain: string): boolean {
  const list = loadDisposableDomains();
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  for (let i = 0; i < labels.length - 1; i++) {
    if (list.has(labels.slice(i).join("."))) return true;
  }
  return false;
}
