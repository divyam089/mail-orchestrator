import { describe, expect, it } from "vitest";
import { decideVerification } from "@/lib/verify/decide";
import { DnsLookupError, lookupMailHost, type DnsResolver, type MxRecord } from "@/lib/verify/dns";
import { isDisposableDomain } from "@/lib/verify/disposable";
import { isRoleAccount } from "@/lib/verify/roles";

class FakeDns implements DnsResolver {
  readonly calls: string[] = [];
  mx = new Map<string, MxRecord[] | DnsLookupError>();
  v4 = new Map<string, string[] | DnsLookupError>();
  v6 = new Map<string, string[] | DnsLookupError>();

  async resolveMx(domain: string): Promise<MxRecord[]> {
    this.calls.push(`mx ${domain}`);
    return this.take(this.mx, domain, "ENODATA");
  }

  async resolve4(domain: string): Promise<string[]> {
    this.calls.push(`a ${domain}`);
    return this.take(this.v4, domain, "ENODATA");
  }

  async resolve6(domain: string): Promise<string[]> {
    this.calls.push(`aaaa ${domain}`);
    return this.take(this.v6, domain, "ENODATA");
  }

  private take<T>(table: Map<string, T | DnsLookupError>, domain: string, absent: "ENODATA" | "ENOTFOUND"): T {
    if (!table.has(domain)) throw new DnsLookupError(absent, domain);
    const value = table.get(domain) as T | DnsLookupError;
    if (value instanceof DnsLookupError) throw value;
    return value;
  }
}

const pass = { state: "pass", via: "mx" } as const;

describe("mail host lookup", () => {
  it("treats a null MX as a domain that does not accept mail and does not query A", async () => {
    const dns = new FakeDns();
    dns.mx.set("nowhere.test", [{ exchange: ".", priority: 0 }]);
    dns.v4.set("nowhere.test", ["203.0.113.5"]);
    await expect(lookupMailHost("nowhere.test", dns)).resolves.toEqual({ state: "fail", via: "null-mx" });
    expect(dns.calls).toEqual(["mx nowhere.test"]);
  });

  it("falls back to A or AAAA only when MX records are absent", async () => {
    const addressed = new FakeDns();
    addressed.mx.set("implicit.test", new DnsLookupError("ENODATA", "no mx"));
    addressed.v4.set("implicit.test", ["203.0.113.9"]);
    await expect(lookupMailHost("implicit.test", addressed)).resolves.toEqual({ state: "pass", via: "implicit-address" });

    const v6 = new FakeDns();
    v6.mx.set("v6.test", []);
    v6.v6.set("v6.test", ["2001:db8::1"]);
    await expect(lookupMailHost("v6.test", v6)).resolves.toEqual({ state: "pass", via: "implicit-address" });

    const missing = new FakeDns();
    missing.mx.set("missing.test", new DnsLookupError("ENOTFOUND", "nxdomain"));
    await expect(lookupMailHost("missing.test", missing)).resolves.toEqual({ state: "fail", via: "no-records" });
    expect(missing.calls).toEqual(["mx missing.test", "a missing.test", "aaaa missing.test"]);
  });

  it("keeps a timeout or server failure unknown and does not guess an address", async () => {
    const slow = new FakeDns();
    slow.mx.set("slow.test", new DnsLookupError("ETIMEOUT", "timed out"));
    slow.v4.set("slow.test", ["203.0.113.5"]);
    await expect(lookupMailHost("slow.test", slow)).resolves.toEqual({ state: "unknown", via: "timeout" });
    expect(slow.calls).toEqual(["mx slow.test"]);

    const failed = new FakeDns();
    failed.mx.set("fail.test", new DnsLookupError("ESERVFAIL", "servfail"));
    await expect(lookupMailHost("fail.test", failed)).resolves.toEqual({ state: "unknown", via: "servfail" });

    const addressTimeout = new FakeDns();
    addressTimeout.mx.set("later.test", new DnsLookupError("ENODATA", "no mx"));
    addressTimeout.v4.set("later.test", new DnsLookupError("ETIMEOUT", "timed out"));
    await expect(lookupMailHost("later.test", addressTimeout)).resolves.toEqual({ state: "unknown", via: "timeout" });
    expect(addressTimeout.calls).not.toContain("aaaa later.test");
  });
});

describe("verification decision", () => {
  it("leaves an MX pass unknown unless the owner policy or a provider says valid", () => {
    expect(decideVerification({ mx: pass, role: false, disposable: false, provider: null, treatMxPassAsValid: false }).status).toBe(
      "unknown",
    );
    expect(decideVerification({ mx: pass, role: false, disposable: false, provider: null, treatMxPassAsValid: true }).status).toBe(
      "valid",
    );
    expect(
      decideVerification({
        mx: pass,
        role: false,
        disposable: false,
        provider: { provider: "test-vendor", status: "valid", reason: "yes" },
        treatMxPassAsValid: false,
      }).status,
    ).toBe("valid");
  });

  it("lets a failed MX, a role, and a disposable domain outrank a provider valid", () => {
    const provider = { provider: "test-vendor", status: "valid" as const, reason: "yes" };
    expect(decideVerification({ mx: { state: "fail", via: "null-mx" }, role: false, disposable: false, provider, treatMxPassAsValid: true }).status).toBe(
      "invalid",
    );
    expect(decideVerification({ mx: pass, role: true, disposable: false, provider, treatMxPassAsValid: true }).status).toBe("risky");
    expect(decideVerification({ mx: pass, role: false, disposable: true, provider, treatMxPassAsValid: true }).status).toBe("risky");
    expect(
      decideVerification({
        mx: { state: "unknown", via: "timeout" },
        role: false,
        disposable: false,
        provider,
        treatMxPassAsValid: true,
      }).status,
    ).toBe("unknown");
  });
});

describe("role and disposable lists", () => {
  it("matches RFC 2142 names and ignores a personal local part", () => {
    expect(isRoleAccount("info+sales@acme.test")).toBe(true);
    expect(isRoleAccount("postmaster@acme.test")).toBe(true);
    expect(isRoleAccount("jane.doe@acme.test")).toBe(false);
  });

  it("uses the vendored CC0 blocklist, including a parent domain", () => {
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("inbox.mailinator.com")).toBe(true);
    expect(isDisposableDomain("acme.test")).toBe(false);
  });
});
