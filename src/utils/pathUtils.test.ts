import { describe, it, expect } from "vitest";
import { isStrictSubpath, normalizeSep } from "./pathUtils";

describe("normalizeSep", () => {
  it("appends a separator only when missing", () => {
    expect(normalizeSep("/a/b")).toBe("/a/b/");
    expect(normalizeSep("/a/b/")).toBe("/a/b/");
    expect(normalizeSep("C:\\a\\b\\")).toBe("C:\\a\\b\\");
  });
});

describe("isStrictSubpath", () => {
  it("accepts a real child path", () => {
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/abc")).toBe(true);
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/abc/def")).toBe(true);
  });

  it("unifies separators", () => {
    expect(isStrictSubpath("C:\\notes\\.assets", "C:/notes/.assets/abc")).toBe(true);
  });

  it("rejects the base itself", () => {
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets")).toBe(false);
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/")).toBe(false);
  });

  it("rejects a traversal that escapes back to (or above) the base", () => {
    // `${notesDir}/.assets/..` — the core exploit path
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/..")).toBe(false);
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/../../etc")).toBe(false);
    expect(isStrictSubpath("/notes/.assets", "/notes")).toBe(false);
    expect(isStrictSubpath("/notes/.assets", "/other/.assets/abc")).toBe(false);
  });

  it("treats an interior traversal that stays inside as contained", () => {
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/a/../b")).toBe(true);
  });

  it("mirrors Win32 trailing dot/space stripping so it can't be aliased", () => {
    // `...` collapses to the base itself.
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/...")).toBe(false);
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/ ")).toBe(false);
    // `.. ` collapses to `..` and climbs to the notes root.
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/.. ")).toBe(false);
    // A trailing-dot segment that still leaves a real child stays contained.
    expect(isStrictSubpath("/notes/.assets", "/notes/.assets/abc.")).toBe(true);
  });
});
