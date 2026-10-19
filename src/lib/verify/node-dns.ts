import { promises as dns } from "node:dns";
import { DnsLookupError, type DnsErrorCode, type DnsResolver } from "@/lib/verify/dns";

const DEFAULT_TIMEOUT_MS = 5_000;

function mapNodeError(error: unknown): DnsLookupError {
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : "DNS lookup failed";
  const known: Record<string, DnsErrorCode> = {
    ENOTFOUND: "ENOTFOUND",
    ENODATA: "ENODATA",
    ETIMEOUT: "ETIMEOUT",
    ESERVFAIL: "ESERVFAIL",
    EAI_AGAIN: "ESERVFAIL",
  };
  return new DnsLookupError(known[code] ?? "EOTHER", message);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DnsLookupError("ETIMEOUT", "DNS lookup timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(mapNodeError(error));
      },
    );
  });
}

/** Real resolver. Tests pass a fake DnsResolver and do not call this. */
export function createNodeDnsResolver(timeoutMs = DEFAULT_TIMEOUT_MS): DnsResolver {
  return {
    resolveMx: (domain) => withTimeout(dns.resolveMx(domain), timeoutMs),
    resolve4: (domain) => withTimeout(dns.resolve4(domain), timeoutMs),
    resolve6: (domain) => withTimeout(dns.resolve6(domain), timeoutMs),
  };
}
