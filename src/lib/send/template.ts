/**
 * Merge fields and spintax.
 * {{field}} is required. {{field|fallback}} is optional.
 * {Hi|Hello} picks one option. Merge tokens are shielded so {{a|b}} is not spintax.
 */

const MERGE = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\s*\}\}/g;
const SPIN = /\{([^{}]+)\}/g;

export type Rng = () => number;

export type RenderResult = { text: string; missing: string[] };

export function renderTemplate(template: string, vars: Record<string, string | null | undefined>, rng: Rng = Math.random): RenderResult {
  const missing: string[] = [];
  const shielded: string[] = [];
  const parked = template.replace(MERGE, (full) => {
    shielded.push(full);
    return `\u0000${shielded.length - 1}\u0000`;
  });
  const spun = parked.replace(SPIN, (full, inner: string) => {
    if (!inner.includes("|")) return full;
    const options = inner.split("|").map((part) => part.trim()).filter((part) => part.length > 0);
    if (options.length < 2) return full;
    const index = Math.floor(rng() * options.length);
    return options[index] ?? options[0];
  });
  const lines = spun.split("\n");
  const out: string[] = [];
  let dropBlank = false;
  for (const line of lines) {
    const restored = line.replace(/\u0000(\d+)\u0000/g, (_mark, index: string) => {
      const token = shielded[Number(index)] ?? "";
      const match = token.match(/^\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\s*\}\}$/);
      if (!match) return "";
      const field = match[1];
      const fallback = match[2];
      const value = vars[field];
      const text = value == null ? "" : String(value).trim();
      if (text) return text;
      if (fallback !== undefined) return fallback;
      missing.push(field);
      return "";
    });
    const onlyToken = line.trim().startsWith("\u0000") && line.trim().endsWith("\u0000") && !line.trim().slice(1, -1).includes("\u0000");
    if (onlyToken && restored.trim() === "") {
      dropBlank = true;
      continue;
    }
    if (dropBlank && restored.trim() === "") {
      dropBlank = false;
      continue;
    }
    dropBlank = false;
    out.push(restored);
  }
  return { text: out.join("\n"), missing: [...new Set(missing)] };
}

export function looksLikeHtml(body: string): boolean {
  const low = body.toLowerCase();
  return low.includes("<html") || low.includes("<a ") || low.includes("<img");
}

export function withFooter(
  body: string,
  footer: { unsubscribeUrl: string; legalName: string; postalAddress: string },
): string {
  const trimmed = body.replace(/\s+$/, "");
  const hasUnsub = trimmed.includes(footer.unsubscribeUrl) && /unsubscribe/i.test(trimmed);
  const hasPostal = trimmed.includes(footer.postalAddress) && trimmed.includes(footer.legalName);
  if (hasUnsub && hasPostal) return `${trimmed}\n`;
  return `${trimmed}\n\nUnsubscribe: ${footer.unsubscribeUrl}\n\n${footer.legalName}\n${footer.postalAddress}\n`;
}

/** Rewrites http(s) links only when the campaign asked for click tracking. */
export function applyClickTracking(body: string, base: string, token: string): string {
  const root = base.replace(/\/$/, "");
  return body.replace(/https?:\/\/[^\s<>]+/g, (url) => {
    if (url.startsWith(`${root}/u/`) || url.startsWith(`${root}/o/`) || url.startsWith(`${root}/c/`)) return url;
    return `${root}/c/${token}?u=${encodeURIComponent(url)}`;
  });
}

export function applyOpenBeacon(body: string, base: string, token: string): string {
  const root = base.replace(/\/$/, "");
  const beacon = `${root}/o/${token}`;
  if (body.includes(beacon)) return body;
  return `${body.replace(/\s+$/, "")}\n${beacon}\n`;
}

export type ComposeInput = {
  subjectTemplate: string | null;
  bodyTemplate: string;
  vars: Record<string, string | null | undefined>;
  stepNumber: number;
  firstSubject: string | null;
  unsubscribeUrl: string;
  legalName: string;
  postalAddress: string;
  trackOpens: boolean;
  trackClicks: boolean;
  rng?: Rng;
};

export type Composed = { subject: string; body: string; missing: string[] };

export function composeMessage(input: ComposeInput): Composed {
  const rng = input.rng ?? Math.random;
  const subjectRendered =
    input.stepNumber > 1
      ? { text: `Re: ${input.firstSubject ?? ""}`, missing: [] as string[] }
      : renderTemplate(input.subjectTemplate ?? "", input.vars, rng);
  const bodyRendered = renderTemplate(input.bodyTemplate, input.vars, rng);
  let body = bodyRendered.text;
  if (input.trackClicks) body = applyClickTracking(body, input.unsubscribeUrl.replace(/\/u\/.*$/, ""), input.vars.unsub_token ?? "t");
  if (input.trackOpens) {
    const base = input.unsubscribeUrl.replace(/\/u\/.*$/, "");
    body = applyOpenBeacon(body, base, input.vars.unsub_token ?? "t");
  }
  body = withFooter(body, {
    unsubscribeUrl: input.unsubscribeUrl,
    legalName: input.legalName,
    postalAddress: input.postalAddress,
  });
  return {
    subject: subjectRendered.text.trim(),
    body,
    missing: [...new Set([...subjectRendered.missing, ...bodyRendered.missing])],
  };
}

export function previewLead(input: ComposeInput): Composed {
  return composeMessage(input);
}
