/**
 * Scheme hygiene for link hrefs.
 *
 * All user-entered link text should flow through this module so scheme
 * validation stays consistent across the link popover, the Tiptap Link
 * extension's own validator (`isAllowedUri`), and any future paste or
 * export sanitizer.
 *
 * The list is a positive allow-list — anything not explicitly permitted
 * is rejected. Returning an empty string (rather than the raw input) for
 * rejected schemes is deliberate: callers that key off truthiness will
 * drop bad input silently instead of relying on downstream code to
 * re-check.
 */

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

/**
 * True if `href` is safe to render or store as a link target. Accepts
 * allow-listed schemes, fragments, absolute/relative paths, and
 * schemeless values (the caller decides whether to prefix a protocol).
 */
export function isSafeLinkHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#") || trimmed.startsWith("/")) return true;

  const scheme = extractScheme(trimmed);
  if (scheme === null) return true;
  return SAFE_LINK_PROTOCOLS.has(scheme);
}

/**
 * Normalize user-entered link text into a safe href suitable for storage.
 *
 *   Empty input                → ""           (no link)
 *   Fragment / absolute path   → passthrough
 *   Allow-listed scheme        → passthrough
 *   Disallowed scheme          → ""           (explicit rejection)
 *   No scheme (bare host)      → `https://…`
 */
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
