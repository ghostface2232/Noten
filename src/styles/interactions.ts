export const MOTION_DURATION_FAST = "var(--motion-fast)";
export const MOTION_DURATION_BASE = "var(--motion-base)";
export const MOTION_DURATION_MEDIUM = "var(--motion-medium)";
export const MOTION_DURATION_SLOW = "var(--motion-slow)";
export const MOTION_DURATION_SLOWER = "var(--motion-slower)";
export const MOTION_DURATION_SLOWEST = "var(--motion-slowest)";

export const MOTION_FAST_MS = 120;

export const pressableButton = {
  transitionProperty: "background-color, color, scale",
  transitionDuration: MOTION_DURATION_FAST,
  transitionTimingFunction: "ease-out",
  ":active": {
    scale: 0.96,
  },
} as const;
