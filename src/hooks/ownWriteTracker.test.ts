import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOwnWritesForTests, isOwnWrite, markOwnWrite, pruneOwnWrites } from "./ownWriteTracker";

afterEach(() => {
  vi.useRealTimers();
  clearOwnWritesForTests();
});

describe("ownWriteTracker", () => {
  it("matches the same path and hash", () => {
    markOwnWrite("C:\\Notes\\a.md", "abc");
    expect(isOwnWrite("c:/notes/a.md", "abc")).toBe(true);
    expect(isOwnWrite("c:/notes/a.md", "def")).toBe(false);
  });

  it("supports deletion as a null expected hash", () => {
    markOwnWrite("C:/Notes/a.md", null);
    expect(isOwnWrite("c:/notes/a.md", null)).toBe(true);
    expect(isOwnWrite("c:/notes/a.md", "abc")).toBe(false);
  });

  it("keeps compatibility when no actual hash is supplied", () => {
    markOwnWrite("C:/Notes/a.md", "abc");
    expect(isOwnWrite("c:/notes/a.md")).toBe(true);
  });

  it("prunes entries by ttl only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    markOwnWrite("C:/Notes/a.md", "abc");

    vi.setSystemTime(31_001);
    pruneOwnWrites();
    expect(isOwnWrite("c:/notes/a.md", "abc")).toBe(false);
  });
});
