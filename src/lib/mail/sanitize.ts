const BLOCKED = new Set(["script", "style", "iframe", "object", "embed", "form", "link", "meta", "svg", "math"]);
const ALLOWED = new Set(["p", "br", "strong", "em", "b", "i", "u", "a", "ul", "ol", "li", "blockquote", "div", "span", "h1", "h2", "h3"]);

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function safeHref(raw: string): string | null {
  const value = raw.trim().replace(/[\u0000-\u001f\s]+/g, "");
  if (/^(https?:|mailto:)/i.test(value)) return value;
  return null;
}

/** Allowlisted HTML. Scripts, event handlers, and non-http(s)/mailto links are removed. */
export function sanitizeHtml(input: string): string {
  let html = input.replace(/\u0000/g, "");
  html = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of BLOCKED) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
    html = html.replace(paired, "");
  }
  html = html.replace(/<\/?([a-zA-Z0-9:-]+)(\s[^<>]*)?>/g, (full, rawName: string, rawAttrs: string | undefined) => {
    const name = rawName.toLowerCase();
    if (BLOCKED.has(name) || !ALLOWED.has(name)) return "";
    if (full.startsWith("</")) return `</${name}>`;
    if (name === "br") return "<br>";
    if (name === "a") {
      const attrs = rawAttrs ?? "";
      const match = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      const href = safeHref(match?.[1] ?? match?.[2] ?? match?.[3] ?? "");
      if (!href) return "<a>";
      return `<a href="${escapeAttr(href)}">`;
    }
    return `<${name}>`;
  });
  return html;
}

export function htmlToText(html: string): string {
  return sanitizeHtml(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|li|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
