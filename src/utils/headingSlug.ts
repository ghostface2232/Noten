import type { OutlineHeading } from "./outline";

/**
 * GitHub-style anchor slug: NFC-normalize, lowercase, strip everything except
 * Unicode letters/numbers/marks/whitespace/hyphens/underscores, then map
 * whitespace to "-". Faithful to GitHub's slugger: consecutive spaces produce
 * consecutive hyphens and edges are not trimmed, so slugs stay portable across
 * GitHub/VS Code markdown previews. Idempotent on already-slugged input.
 */
export function slugifyHeading(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

export interface HeadingAnchor {
  slug: string;
  heading: OutlineHeading;
}

/**
 * Slug per heading in document order, with GitHub's duplicate rule: the first
 * occurrence keeps the bare slug, later ones get "-1", "-2", ... A heading
 * literally titled "a-1" alongside duplicate "a" headings can collide — the
 * simple counter is kept (raw-title fallback in the resolver still covers it).
 */
export function buildHeadingAnchors(headings: OutlineHeading[]): HeadingAnchor[] {
  const counts = new Map<string, number>();
  return headings.map((heading) => {
    const base = slugifyHeading(heading.text);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    return { slug: seen === 0 ? base : `${base}-${seen}`, heading };
  });
}

function decodeFragment(fragment: string): string {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  try {
    return decodeURIComponent(raw).normalize("NFC");
  } catch {
    return raw.normalize("NFC");
  }
}

/**
 * Tolerant click-time resolver for a "#fragment" href. First hit in document
 * order wins; the chain accepts stored slugs, hand-typed raw titles, and
 * percent-encoded forms:
 *   1. exact match against deduped slugs
 *   2. slugified fragment match (covers "#My Heading")
 *   3. raw heading-text match: trimmed exact, then case-insensitive
 */
export function resolveHeadingFragment(
  headings: OutlineHeading[],
  fragment: string,
): OutlineHeading | null {
  const needle = decodeFragment(fragment);
  if (!needle.trim()) return null;

  const anchors = buildHeadingAnchors(headings);
  const bySlug = anchors.find((a) => a.slug === needle);
  if (bySlug) return bySlug.heading;

  const slugged = slugifyHeading(needle);
  if (slugged) {
    const byslugged = anchors.find((a) => a.slug === slugged);
    if (byslugged) return byslugged.heading;
  }

  const title = needle.trim();
  const byTitle = headings.find((h) => h.text.normalize("NFC").trim() === title);
  if (byTitle) return byTitle;

  const lower = title.toLowerCase();
  return (
    headings.find((h) => h.text.normalize("NFC").trim().toLowerCase() === lower) ?? null
  );
}

/**
 * Popover apply-time normalization: "#My Heading" -> "#my-heading".
 * "" / "#" / "#   " normalize to "" (caller unsets the link). Idempotent on
 * already-slugged values.
 */
export function normalizeFragmentHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("#")) return trimmed ? `#${slugifyHeading(trimmed)}` : "";
  const slug = slugifyHeading(trimmed.slice(1).trim());
  return slug ? `#${slug}` : "";
}

/**
 * Autocomplete filter for the link popover: empty query lists every heading;
 * otherwise match on the slug (space-insensitive via slugification) or on the
 * raw title, case-insensitively.
 */
export function filterHeadingAnchors(
  anchors: HeadingAnchor[],
  query: string,
): HeadingAnchor[] {
  const trimmed = query.trim();
  if (!trimmed) return anchors;
  const slugged = slugifyHeading(trimmed);
  const lower = trimmed.normalize("NFC").toLowerCase();
  return anchors.filter(
    (a) =>
      (slugged && a.slug.includes(slugged))
      || a.heading.text.normalize("NFC").toLowerCase().includes(lower),
  );
}
