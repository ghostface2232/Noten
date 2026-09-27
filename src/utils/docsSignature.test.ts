import { describe, it, expect } from "vitest";
import { sortSignature } from "./docsSignature";
import type { NoteDoc } from "./noteTypes";

function makeDoc(overrides: Partial<NoteDoc> & { id: string }): NoteDoc {
  return {
    filePath: `/notes/${overrides.id}.md`,
    fileName: overrides.id,
    isDirty: false,
    content: "",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as NoteDoc;
}

const base = [
  makeDoc({ id: "a", fileName: "Alpha", createdAt: 10, updatedAt: 20 }),
  makeDoc({ id: "b", fileName: "Beta", createdAt: 11, updatedAt: 21 }),
];

describe("sortSignature", () => {
  it("ignores fields the sidebar comparator does not read", () => {
    const edited = base.map((doc) => ({ ...doc, content: "typed some more", isDirty: true }));
    expect(sortSignature(edited, "updated-desc", "ko")).toBe(sortSignature(base, "updated-desc", "ko"));
  });

  it.each([
    ["title", (docs: NoteDoc[]) => [{ ...docs[0], fileName: "Alpha!" }, docs[1]]],
    ["updatedAt", (docs: NoteDoc[]) => [{ ...docs[0], updatedAt: 99 }, docs[1]]],
    ["createdAt", (docs: NoteDoc[]) => [{ ...docs[0], createdAt: 99 }, docs[1]]],
    ["pinned", (docs: NoteDoc[]) => [{ ...docs[0], pinned: true }, docs[1]]],
    ["id", (docs: NoteDoc[]) => [{ ...docs[0], id: "z" }, docs[1]]],
    ["order", (docs: NoteDoc[]) => [docs[1], docs[0]]],
    ["membership", (docs: NoteDoc[]) => [docs[0]]],
  ])("changes when %s changes", (_label, mutate) => {
    expect(sortSignature(mutate(base), "updated-desc", "ko")).not.toBe(
      sortSignature(base, "updated-desc", "ko"),
    );
  });

  it("changes when the sort order or locale changes", () => {
    const reference = sortSignature(base, "updated-desc", "ko");
    expect(sortSignature(base, "title-asc", "ko")).not.toBe(reference);
    expect(sortSignature(base, "updated-desc", "en")).not.toBe(reference);
  });

  it("separates fields so concatenation cannot alias", () => {
    const split = [makeDoc({ id: "ab", fileName: "c" })];
    const shifted = [makeDoc({ id: "a", fileName: "bc" })];
    expect(sortSignature(split, "updated-desc", "ko")).not.toBe(
      sortSignature(shifted, "updated-desc", "ko"),
    );
  });

  it("handles an empty list", () => {
    expect(sortSignature([], "updated-desc", "ko")).toBe(sortSignature([], "updated-desc", "ko"));
    expect(sortSignature([], "updated-desc", "ko")).not.toBe(sortSignature(base, "updated-desc", "ko"));
  });

  it("does not collide across a large synthetic library", () => {
    const docs = Array.from({ length: 2000 }, (_, i) => makeDoc({
      id: `id-${i}`,
      fileName: `Note ${i}`,
      createdAt: 1_700_000_000_000 + i,
      updatedAt: 1_700_000_100_000 + i,
    }));
    const seen = new Set<string>();
    for (let i = 0; i < docs.length; i++) {
      // Nudge one note at a time; every variant must hash differently.
      const variant = docs.slice();
      variant[i] = { ...variant[i], updatedAt: variant[i].updatedAt + 1 };
      seen.add(sortSignature(variant, "updated-desc", "ko"));
    }
    expect(seen.size).toBe(docs.length);
  });
});
