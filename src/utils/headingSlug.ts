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
 * Slug per linkable heading in document order, with GitHub's duplicate rule:
 * the first occurrence keeps the bare slug and later collisions get "-1",
 * "-2", ... Every assigned slug is reserved so a literal title such as "a-1"
 * cannot collide with the suffix generated for a duplicate "a" heading.
 */
export function buildHeadingAnchors(headings: OutlineHeading[]): HeadingAnchor[] {
  const anchors: HeadingAnchor[] = [];
  const used = new Set<string>();
  const suffixes = new Map<string, number>();

  for (const heading of headings) {
    const base = slugifyHeading(heading.text);
    if (!base) continue;

    let suffix = suffixes.get(base) ?? 0;
    let slug = base;
    while (used.has(slug)) {
      suffix += 1;
      slug = `${base}-${suffix}`;
    }

    suffixes.set(base, suffix);
    used.add(slug);
    anchors.push({ slug, heading });
  }

  return anchors;
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
 * Percent-encoded fragments are decoded before slugification; malformed
 * encodings are preserved rather than destructively rewritten. "" / "#" /
 * "#   " normalize to "" (caller unsets the link).
 */
export function normalizeFragmentHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const raw = trimmed.startsWith("#") ? trimmed.slice(1).trim() : trimmed;
  if (!raw) return "";

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }

  const slug = slugifyHeading(decoded.trim());
  return slug ? `#${slug}` : "";
}

/**
 * Autocomplete filter for the link popover. The query excludes the first "#"
 * that enters fragment mode, so each additional leading "#" sets the minimum
 * heading level: "" lists all headings, "#" lists h2-h6, and "##" lists
 * h3-h6. Any remaining text filters by slug or raw title.
 */
export function filterHeadingAnchors(
  anchors: HeadingAnchor[],
  query: string,
): HeadingAnchor[] {
  const trimmed = query.trim();
  const levelPrefixLength = trimmed.match(/^#+/)?.[0].length ?? 0;
  const minimumLevel = levelPrefixLength + 1;
  const textQuery = trimmed.slice(levelPrefixLength).trim();
  const levelMatches = levelPrefixLength === 0
    ? anchors
    : anchors.filter((anchor) => anchor.heading.level >= minimumLevel);

  if (!textQuery) return levelMatches;

  const slugged = slugifyHeading(textQuery);
  const lower = textQuery.normalize("NFC").toLowerCase();
  return levelMatches.filter(
    (a) =>
      (slugged && a.slug.includes(slugged))
      || a.heading.text.normalize("NFC").toLowerCase().includes(lower),
  );
}
