export function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )figcel_csrf=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function csrfHeaders(headers: Record<string, string> = {}): Record<string, string> {
  return { ...headers, "x-csrf-token": csrfToken() };
}

export function errorText(data: { error?: unknown; reason?: string } | null, fallback: string): string {
  const error = data?.error;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return data?.reason || fallback;
}
