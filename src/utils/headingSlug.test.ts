import { describe, it, expect } from "vitest";
import type { OutlineHeading } from "./outline";
import {
  buildHeadingAnchors,
  filterHeadingAnchors,
  normalizeFragmentHref,
  resolveHeadingFragment,
  slugifyHeading,
} from "./headingSlug";

function heading(text: string, pos: number, level = 2): OutlineHeading {
  return { text, level, pos };
}

describe("slugifyHeading", () => {
  it("lowercases and maps spaces to hyphens", () => {
    expect(slugifyHeading("My Heading")).toBe("my-heading");
  });

  it("keeps consecutive spaces as consecutive hyphens (GitHub-faithful)", () => {
    expect(slugifyHeading("a  b")).toBe("a--b");
  });

  it("strips punctuation but keeps hyphens and underscores", () => {
    expect(slugifyHeading("What's new? (v2.0)")).toBe("whats-new-v20");
    expect(slugifyHeading("snake_case-kebab")).toBe("snake_case-kebab");
  });

  it("preserves Hangul in composed NFC form", () => {
    expect(slugifyHeading("서론 개요")).toBe("서론-개요");
    // NFD input (decomposed jamo) composes to the same slug.
    expect(slugifyHeading("서론 개요".normalize("NFD"))).toBe("서론-개요");
  });

  it("returns hyphens-only for whitespace-only input and empty for empty", () => {
    expect(slugifyHeading("")).toBe("");
    expect(slugifyHeading("!!!")).toBe("");
  });

  it("is idempotent on already-slugged values", () => {
    expect(slugifyHeading("my-heading-1")).toBe("my-heading-1");
    expect(slugifyHeading(slugifyHeading("My Heading"))).toBe("my-heading");
  });
});

describe("buildHeadingAnchors", () => {
  it("suffixes duplicate slugs -1, -2 in document order", () => {
    const anchors = buildHeadingAnchors([
      heading("Intro", 0),
      heading("Intro", 10),
      heading("Intro", 20),
    ]);
    expect(anchors.map((a) => a.slug)).toEqual(["intro", "intro-1", "intro-2"]);
    expect(anchors.map((a) => a.heading.pos)).toEqual([0, 10, 20]);
  });

  it("treats different titles independently", () => {
    const anchors = buildHeadingAnchors([heading("A", 0), heading("B", 5), heading("A", 9)]);
    expect(anchors.map((a) => a.slug)).toEqual(["a", "b", "a-1"]);
  });

  it("keeps every generated slug unique when a title collides with a suffix", () => {
    const anchors = buildHeadingAnchors([
      heading("A", 0),
      heading("A", 5),
      heading("A-1", 9),
    ]);
    expect(anchors.map((a) => a.slug)).toEqual(["a", "a-1", "a-1-1"]);
    expect(resolveHeadingFragment(anchors.map((a) => a.heading), "#a-1-1")?.pos).toBe(9);
  });

  it("skips suffixes already reserved by literal heading titles", () => {
    const anchors = buildHeadingAnchors([
      heading("A", 0),
      heading("A-1", 5),
      heading("A", 9),
    ]);
    expect(anchors.map((a) => a.slug)).toEqual(["a", "a-1", "a-2"]);
  });

  it("omits headings that cannot produce a linkable slug", () => {
    const anchors = buildHeadingAnchors([
      heading("Intro", 0),
      heading("!!!", 5),
      heading("", 9),
    ]);
    expect(anchors.map((a) => a.slug)).toEqual(["intro"]);
  });
});

describe("resolveHeadingFragment", () => {
  const headings = [
    heading("서론 개요", 0, 1),
    heading("My Heading", 12),
    heading("My Heading", 30),
    heading("100% Done", 50),
  ];

  it("resolves an exact slug, with or without leading #", () => {
    expect(resolveHeadingFragment(headings, "#서론-개요")?.pos).toBe(0);
    expect(resolveHeadingFragment(headings, "my-heading")?.pos).toBe(12);
  });

  it("resolves percent-encoded Hangul slugs", () => {
    expect(
      resolveHeadingFragment(headings, "#%EC%84%9C%EB%A1%A0-%EA%B0%9C%EC%9A%94")?.pos,
    ).toBe(0);
  });

  it("does not throw on malformed percent sequences", () => {
    // decodeURIComponent("100%-done") throws; the raw fragment still resolves
    // via slugification ("100%-done" and "100% Done" both slug to "100-done").
    expect(resolveHeadingFragment(headings, "#100%-done")?.pos).toBe(50);
    expect(resolveHeadingFragment(headings, "#100%")).toBeNull();
  });

  it("resolves hand-typed raw titles via slugification", () => {
    expect(resolveHeadingFragment(headings, "#My Heading")?.pos).toBe(12);
  });

  it("falls back to raw title match, exact then case-insensitive", () => {
    expect(resolveHeadingFragment(headings, "#서론 개요")?.pos).toBe(0);
    expect(resolveHeadingFragment(headings, "#MY HEADING")?.pos).toBe(12);
  });

  it("resolves duplicate suffixes to the later heading", () => {
    expect(resolveHeadingFragment(headings, "#my-heading-1")?.pos).toBe(30);
  });

  it("returns null for misses and empty fragments", () => {
    expect(resolveHeadingFragment(headings, "#nope")).toBeNull();
    expect(resolveHeadingFragment(headings, "#")).toBeNull();
    expect(resolveHeadingFragment(headings, "")).toBeNull();
    expect(resolveHeadingFragment([], "#anything")).toBeNull();
  });
});

describe("normalizeFragmentHref", () => {
  it("slugifies fragment hrefs", () => {
    expect(normalizeFragmentHref("#My Heading")).toBe("#my-heading");
    expect(normalizeFragmentHref("#서론 개요")).toBe("#서론-개요");
  });

  it("normalizes empty and bare-# input to empty string", () => {
    expect(normalizeFragmentHref("")).toBe("");
    expect(normalizeFragmentHref("#")).toBe("");
    expect(normalizeFragmentHref("#   ")).toBe("");
  });

  it("is idempotent on already-slugged values", () => {
    expect(normalizeFragmentHref("#my-heading-1")).toBe("#my-heading-1");
    expect(normalizeFragmentHref(normalizeFragmentHref("#My Heading"))).toBe("#my-heading");
  });

  it("decodes percent-encoded fragments before slugifying", () => {
    expect(normalizeFragmentHref("#%EC%84%9C%EB%A1%A0-%EA%B0%9C%EC%9A%94")).toBe(
      "#서론-개요",
    );
  });

  it("slugifies malformed percent-encoded fragments into safe destinations", () => {
    expect(normalizeFragmentHref("#broken%2-fragment")).toBe("#broken2-fragment");
    expect(normalizeFragmentHref("#broken%2 fragment")).toBe("#broken2-fragment");
  });
});

describe("filterHeadingAnchors", () => {
  const anchors = buildHeadingAnchors([
    heading("서론 개요", 0, 1),
    heading("My Heading", 12),
    heading("Appendix", 30),
  ]);

  it("returns all anchors for an empty query", () => {
    expect(filterHeadingAnchors(anchors, "")).toHaveLength(3);
    expect(filterHeadingAnchors(anchors, "   ")).toHaveLength(3);
  });

  it("matches slugs space-insensitively", () => {
    expect(filterHeadingAnchors(anchors, "my head").map((a) => a.slug)).toEqual([
      "my-heading",
    ]);
  });

  it("matches raw titles case-insensitively", () => {
    expect(filterHeadingAnchors(anchors, "APPEN").map((a) => a.slug)).toEqual(["appendix"]);
    expect(filterHeadingAnchors(anchors, "서론").map((a) => a.slug)).toEqual(["서론-개요"]);
  });

  it("returns empty for no matches", () => {
    expect(filterHeadingAnchors(anchors, "zzz")).toEqual([]);
  });

  it("uses additional leading hashes as a minimum heading-level filter", () => {
    const hierarchy = buildHeadingAnchors([
      heading("Overview", 0, 1),
      heading("Install", 10, 2),
      heading("Windows", 20, 3),
      heading("Advanced", 30, 4),
    ]);

    expect(filterHeadingAnchors(hierarchy, "").map((a) => a.heading.level)).toEqual([
      1, 2, 3, 4,
    ]);
    expect(filterHeadingAnchors(hierarchy, "#").map((a) => a.heading.level)).toEqual([
      2, 3, 4,
    ]);
    expect(filterHeadingAnchors(hierarchy, "##").map((a) => a.heading.level)).toEqual([
      3, 4,
    ]);
    expect(filterHeadingAnchors(hierarchy, "###").map((a) => a.heading.level)).toEqual([4]);
  });

  it("combines the heading-level prefix with title filtering", () => {
    const hierarchy = buildHeadingAnchors([
      heading("Install", 0, 2),
      heading("Install on Windows", 10, 3),
      heading("Install on Linux", 20, 4),
    ]);

    expect(filterHeadingAnchors(hierarchy, "##windows").map((a) => a.slug)).toEqual([
      "install-on-windows",
    ]);
    expect(filterHeadingAnchors(hierarchy, "###windows")).toEqual([]);
  });
});
