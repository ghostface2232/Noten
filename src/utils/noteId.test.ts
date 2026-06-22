import { describe, it, expect } from "vitest";
import { isValidNoteId } from "./noteId";

describe("isValidNoteId", () => {
  it("accepts UUIDs and ordinary imported/legacy stems", () => {
    expect(isValidNoteId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isValidNoteId("my-note_2024.draft")).toBe(true);
    expect(isValidNoteId("회의록")).toBe(true);
    expect(isValidNoteId("My Note")).toBe(true); // spaces are valid in filenames
    expect(isValidNoteId("a")).toBe(true);
  });

  it("rejects path-traversal segments", () => {
    expect(isValidNoteId("..")).toBe(false);
    expect(isValidNoteId(".")).toBe(false);
    expect(isValidNoteId("../x")).toBe(false);
    expect(isValidNoteId("..\\x")).toBe(false);
  });

  it("rejects ids Win32 would alias by trimming trailing dots/spaces", () => {
    // `.assets/...` -> `.assets`, `.assets/ ` -> `.assets`: mass image delete.
    expect(isValidNoteId("...")).toBe(false);
    expect(isValidNoteId("....")).toBe(false);
    expect(isValidNoteId(" ")).toBe(false);
    expect(isValidNoteId("   ")).toBe(false);
    // `.assets/.. ` -> `.assets/..` = notes root: total wipe.
    expect(isValidNoteId(".. ")).toBe(false);
    expect(isValidNoteId(". ")).toBe(false);
    // Any trailing dot or space, and leading whitespace.
    expect(isValidNoteId("note.")).toBe(false);
    expect(isValidNoteId("note ")).toBe(false);
    expect(isValidNoteId(" note")).toBe(false);
  });

  it("rejects Windows reserved device names (with or without extension)", () => {
    for (const name of ["CON", "con", "PRN", "AUX", "NUL", "nul.txt", "COM1", "com9", "LPT1", "LPT9"]) {
      expect(isValidNoteId(name)).toBe(false);
    }
    // Lookalikes that are NOT reserved must still pass.
    expect(isValidNoteId("CON2")).toBe(true);
    expect(isValidNoteId("COM10")).toBe(true);
    expect(isValidNoteId("CONSOLE")).toBe(true);
    expect(isValidNoteId("NULL")).toBe(true);
  });

  it("rejects any path separator", () => {
    expect(isValidNoteId("a/b")).toBe(false);
    expect(isValidNoteId("a\\b")).toBe(false);
    expect(isValidNoteId("/etc/passwd")).toBe(false);
  });

  it("rejects Windows-reserved chars (incl. NTFS ADS colon) and control chars", () => {
    expect(isValidNoteId("C:")).toBe(false);
    expect(isValidNoteId("a:b")).toBe(false);
    expect(isValidNoteId("a*b")).toBe(false);
    expect(isValidNoteId("a?b")).toBe(false);
    expect(isValidNoteId('a"b')).toBe(false);
    expect(isValidNoteId("a\nb")).toBe(false);
    expect(isValidNoteId("a\x00b")).toBe(false);
  });

  it("rejects non-strings, empty, and over-long ids", () => {
    expect(isValidNoteId(undefined)).toBe(false);
    expect(isValidNoteId(null)).toBe(false);
    expect(isValidNoteId(42)).toBe(false);
    expect(isValidNoteId("")).toBe(false);
    expect(isValidNoteId("a".repeat(256))).toBe(false);
    expect(isValidNoteId("a".repeat(255))).toBe(true);
  });
});
