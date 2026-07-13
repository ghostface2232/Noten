import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { animateScrollTop } from "./scrollAnimation";

const DURATION = 280;

let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  container.scrollTop = 0;
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function advanceToEnd() {
  // Fake rAF ticks every 16ms; run well past the duration.
  vi.advanceTimersByTime(DURATION * 2);
}

describe("animateScrollTop", () => {
  it("reaches the target exactly after the duration", () => {
    animateScrollTop(container, 500, DURATION);
    advanceToEnd();
    expect(container.scrollTop).toBe(500);
  });

  it("moves monotonically toward the target while animating", () => {
    animateScrollTop(container, 400, DURATION);
    const samples: number[] = [];
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(32);
      samples.push(container.scrollTop);
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0]);
  });

  it("jumps instantly when prefers-reduced-motion is set", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    animateScrollTop(container, 300, DURATION);
    expect(container.scrollTop).toBe(300);
  });

  it("jumps instantly for sub-pixel distances", () => {
    container.scrollTop = 100;
    animateScrollTop(container, 100.4, DURATION);
    expect(container.scrollTop).toBe(100.4);
  });

  it("yields to the user: a wheel event cancels the animation in place", () => {
    animateScrollTop(container, 1000, DURATION);
    vi.advanceTimersByTime(64);
    const midway = container.scrollTop;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1000);

    container.dispatchEvent(new Event("wheel"));
    advanceToEnd();
    expect(container.scrollTop).toBe(midway);
  });

  it("the returned cancel function stops the animation (newer jump wins)", () => {
    const cancel = animateScrollTop(container, 1000, DURATION);
    vi.advanceTimersByTime(64);
    const midway = container.scrollTop;

    cancel();
    animateScrollTop(container, 50, DURATION);
    advanceToEnd();
    expect(container.scrollTop).toBe(50);
    expect(midway).not.toBe(50);
  });

  it("fires onUserCancel only for user input — not for programmatic cancel or completion", () => {
    // User wheel → fires.
    const onWheelCancel = vi.fn();
    animateScrollTop(container, 1000, DURATION, { onUserCancel: onWheelCancel });
    vi.advanceTimersByTime(64);
    container.dispatchEvent(new Event("wheel"));
    expect(onWheelCancel).toHaveBeenCalledTimes(1);
    // A wheel after cancellation must not fire it again.
    container.dispatchEvent(new Event("wheel"));
    expect(onWheelCancel).toHaveBeenCalledTimes(1);

    // Programmatic cancel (newer jump wins) → does not fire.
    const onProgrammaticCancel = vi.fn();
    const cancel = animateScrollTop(container, 1000, DURATION, { onUserCancel: onProgrammaticCancel });
    vi.advanceTimersByTime(64);
    cancel();
    container.dispatchEvent(new Event("wheel"));
    expect(onProgrammaticCancel).not.toHaveBeenCalled();

    // Natural completion → does not fire, and later wheels stay silent.
    const onCompleteCancel = vi.fn();
    animateScrollTop(container, 2000, DURATION, { onUserCancel: onCompleteCancel });
    advanceToEnd();
    container.dispatchEvent(new Event("wheel"));
    expect(onCompleteCancel).not.toHaveBeenCalled();
  });
});
