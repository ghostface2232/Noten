import { describe, expect, it } from "vitest";
import { CLOSE_OVERRIDE_WINDOW_MS, isCloseOverrideArmed } from "./closeGate";

describe("close override window", () => {
  it("is armed only right after a refusal", () => {
    expect(isCloseOverrideArmed(null, 1_000)).toBe(false);
    expect(isCloseOverrideArmed(1_000, 1_000 + 30_000)).toBe(true);
    expect(isCloseOverrideArmed(1_000, 1_000 + CLOSE_OVERRIDE_WINDOW_MS)).toBe(true);
  });

  it("expires, so an old refusal does not skip the explanation", () => {
    expect(isCloseOverrideArmed(1_000, 1_000 + CLOSE_OVERRIDE_WINDOW_MS + 1)).toBe(false);
    expect(isCloseOverrideArmed(1_000, 1_000 + 8 * 60 * 60 * 1000)).toBe(false);
  });

  it("treats a clock that moved backwards as a fresh attempt", () => {
    expect(isCloseOverrideArmed(10_000, 5_000)).toBe(false);
  });
});
