/**
 * Mail-host lookup.
 *
 * RFC 7505: an MX exchange of "." is a null MX. The domain does not accept mail.
 * https://www.rfc-editor.org/rfc/rfc7505
 *
 * RFC 5321 §5.1: if no MX records exist, fall back to the domain's A or AAAA
 * address. That implicit MX is not used when the MX lookup itself fails or times out.
 * https://www.rfc-editor.org/rfc/rfc5321#section-5.1
 */

export type DnsErrorCode = "ENOTFOUND" | "ENODATA" | "ETIMEOUT" | "ESERVFAIL" | "EOTHER";

export class DnsLookupError extends Error {
  readonly code: DnsErrorCode;

  constructor(code: DnsErrorCode, message: string) {
    super(message);
    this.name = "DnsLookupError";
    this.code = code;
  }
}

export type MxRecord = { exchange: string; priority: number };

export interface DnsResolver {
  resolveMx(domain: string): Promise<MxRecord[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export type MxResult =
  | { state: "pass"; via: "mx" | "implicit-address" }
  | { state: "fail"; via: "null-mx" | "no-records" }
  | { state: "unknown"; via: "timeout" | "servfail" };

function codeOf(error: unknown): DnsErrorCode {
  if (error instanceof DnsLookupError) return error.code;
  return "EOTHER";
}

function isAbsent(code: DnsErrorCode): boolean {
  return code === "ENOTFOUND" || code === "ENODATA";
}

type AddressProbe = { kind: "records"; records: string[] } | { kind: "absent" } | { kind: "unknown"; via: "timeout" | "servfail" };

async function probe(lookup: () => Promise<string[]>): Promise<AddressProbe> {
  try {
    const records = await lookup();
    if (records.length === 0) return { kind: "absent" };
    return { kind: "records", records };
  } catch (error) {
    const code = codeOf(error);
    if (isAbsent(code)) return { kind: "absent" };
    return { kind: "unknown", via: code === "ETIMEOUT" ? "timeout" : "servfail" };
  }
}

async function implicitAddress(domain: string, resolver: DnsResolver): Promise<MxResult> {
  const v4 = await probe(() => resolver.resolve4(domain));
  if (v4.kind === "records") return { state: "pass", via: "implicit-address" };
  if (v4.kind === "unknown") return { state: "unknown", via: v4.via };
  const v6 = await probe(() => resolver.resolve6(domain));
  if (v6.kind === "records") return { state: "pass", via: "implicit-address" };
  if (v6.kind === "unknown") return { state: "unknown", via: v6.via };
  return { state: "fail", via: "no-records" };
}

function nullMx(exchange: string): boolean {
  const normalized = exchange.trim().toLowerCase().replace(/\.$/, "");
  return normalized === "" || normalized === ".";
}

export async function lookupMailHost(domain: string, resolver: DnsResolver): Promise<MxResult> {
  let records: MxRecord[];
  try {
    records = await resolver.resolveMx(domain);
  } catch (error) {
    const code = codeOf(error);
    if (isAbsent(code)) return implicitAddress(domain, resolver);
    return { state: "unknown", via: code === "ETIMEOUT" ? "timeout" : "servfail" };
  }
  if (records.some((record) => nullMx(record.exchange))) return { state: "fail", via: "null-mx" };
  if (records.length === 0) return implicitAddress(domain, resolver);
  return { state: "pass", via: "mx" };
}
