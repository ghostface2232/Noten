import { describe, expect, it } from "vitest";
import { detectConflictFile } from "./conflictFileDetector";

describe("detectConflictFile", () => {
  it("detects OneDrive and Dropbox-style note conflicts", () => {
    expect(detectConflictFile("abc (John's conflicted copy 2026-05-01).md")).toEqual(expect.objectContaining({
      kind: "note",
      canonicalName: "abc.md",
    }));
    expect(detectConflictFile("abc (conflicted copy).md")).toEqual(expect.objectContaining({
      kind: "note",
      canonicalName: "abc.md",
    }));
  });

  it("detects numeric copy markers", () => {
    expect(detectConflictFile("abc (2).md")).toEqual(expect.objectContaining({
      kind: "note",
      canonicalName: "abc.md",
      marker: "2",
    }));
  });

  it("classifies manifest, groups, and meta conflicts", () => {
    expect(detectConflictFile("manifest (conflicted copy).json")).toEqual(expect.objectContaining({ kind: "manifest" }));
    expect(detectConflictFile(".groups (conflicted copy).json")).toEqual(expect.objectContaining({ kind: "groups" }));
    expect(detectConflictFile("note-id (conflicted copy).json")).toEqual(expect.objectContaining({ kind: "meta" }));
  });
});
