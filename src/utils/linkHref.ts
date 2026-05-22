// Central allow-list for link schemes. Rejected schemes normalize to "" so
// truthy checks cannot accidentally persist unsafe hrefs.

export const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set([
  "http",
  "https",
  "mailto",
  "tel",
  "ftp",
  "ftps",
  "sms",
]);

const SCHEME_PATTERN = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

function extractScheme(value: string): string | null {
  const match = SCHEME_PATTERN.exec(value);
  return match ? match[1].toLowerCase() : null;
}

export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;

  const scheme = extractScheme(trimmed);
  if (scheme === null) return true;
  return SAFE_LINK_PROTOCOLS.has(scheme);
}

export function normalizeLinkHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return trimmed;

  const scheme = extractScheme(trimmed);
  if (scheme !== null) {
    return SAFE_LINK_PROTOCOLS.has(scheme) ? trimmed : "";
  }
  return `https://${trimmed}`;
}
