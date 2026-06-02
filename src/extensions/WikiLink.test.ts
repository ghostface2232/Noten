import { describe, it, expect } from "vitest";
import { findDocByTitle } from "./WikiLink";
import type { NoteDoc } from "../utils/noteTypes";

function makeDoc(id: string, fileName: string): NoteDoc {
  return {
    id,
    filePath: `/notes/${id}.md`,
    fileName,
    isDirty: false,
    content: "",
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("findDocByTitle", () => {
  it("matches exactly, case-insensitively, and ignores surrounding whitespace", () => {
    const docs = [makeDoc("a", "Hello World"), makeDoc("b", "Notes")];
    expect(findDocByTitle(docs, "Hello World")?.id).toBe("a");
    expect(findDocByTitle(docs, "hello world")?.id).toBe("a");
    expect(findDocByTitle(docs, "  HELLO WORLD  ")?.id).toBe("a");
  });

  it("normalizes Unicode (NFC) the same way for title and query", () => {
    // "é" composed (NFC) vs decomposed (NFD: e + U+0301).
    const docs = [makeDoc("a", "Café")];
    expect(findDocByTitle(docs, "Café")?.id).toBe("a");
  });

  it("returns null for no match and for an empty/whitespace query", () => {
    const docs = [makeDoc("a", "Hello")];
    expect(findDocByTitle(docs, "Goodbye")).toBeNull();
    expect(findDocByTitle(docs, "")).toBeNull();
    expect(findDocByTitle(docs, "   ")).toBeNull();
  });

  it("returns the first doc in array order when titles collide", () => {
    const docs = [makeDoc("first", "Dup"), makeDoc("second", "dup")];
    expect(findDocByTitle(docs, "DUP")?.id).toBe("first");
  });

  it("caches the index per array reference and rebuilds for a new array", () => {
    const docs = [makeDoc("a", "Foo")];
    // Prime the cached index for this array reference.
    expect(findDocByTitle(docs, "Foo")?.id).toBe("a");

    // Mutate a doc in place WITHOUT creating a new array. Because the index is
    // cached by array reference, the stale name is still resolvable and the new
    // name is not — proving the index was reused, not rebuilt per call.
    docs[0].fileName = "Bar";
    expect(findDocByTitle(docs, "Foo")?.id).toBe("a");
    expect(findDocByTitle(docs, "Bar")).toBeNull();

    // A new array reference (how the app propagates changes via setDocs) builds
    // a fresh index reflecting current names.
    const next = [...docs];
    expect(findDocByTitle(next, "Bar")?.id).toBe("a");
    expect(findDocByTitle(next, "Foo")).toBeNull();
  });
});
