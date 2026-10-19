const hits = new Map<string, number[]>();

export function takeRateToken(keyId: string, limit: number, now = Date.now()): boolean {
  const recent = (hits.get(keyId) ?? []).filter((stamp) => now - stamp < 60_000);
  if (recent.length >= limit) {
    hits.set(keyId, recent);
    return false;
  }
  recent.push(now);
  hits.set(keyId, recent);
  return true;
}

export function resetRateLimits(): void {
  hits.clear();
}
