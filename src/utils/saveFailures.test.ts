import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isSaveFailing,
  markSaveFailed,
  markSaveSettled,
  settleSavesWithoutPending,
  subscribeSaveFailures,
} from "./saveFailures";

afterEach(() => settleSavesWithoutPending(() => false));

describe("saveFailures", () => {
  it("stays failing until every failed note has settled", () => {
    markSaveFailed("a", 1);
    markSaveFailed("b", 1);
    markSaveSettled("a", 1);
    expect(isSaveFailing()).toBe(true);

    markSaveSettled("b", 1);
    expect(isSaveFailing()).toBe(false);
  });

  it("is not settled by a save of another note", () => {
    markSaveFailed("a", 1);
    markSaveSettled("other", 1);

    expect(isSaveFailing()).toBe(true);
  });

  it("is not settled by a slower save of an older edit", () => {
    markSaveFailed("a", 2);
    markSaveSettled("a", 1);
    expect(isSaveFailing()).toBe(true);

    markSaveSettled("a", 2);
    expect(isSaveFailing()).toBe(false);
  });

  it("forgets a note with nothing left pending", () => {
    markSaveFailed("kept", 1);
    markSaveFailed("deleted", 1);

    settleSavesWithoutPending((id) => id === "kept");
    expect(isSaveFailing()).toBe(true);

    settleSavesWithoutPending(() => false);
    expect(isSaveFailing()).toBe(false);
  });

  it("tells a subscriber only when the answer changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSaveFailures(listener);

    markSaveFailed("a", 1);
    markSaveFailed("b", 1);
    expect(listener).toHaveBeenCalledTimes(1);

    markSaveSettled("a", 1);
    markSaveSettled("b", 1);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    markSaveFailed("c", 1);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
