import { describe, it, expect, vi } from "vitest";
import {
  AUTO_UPDATE_DRAIN_RETRY_MS,
  AUTO_UPDATE_FOREGROUND_IDLE_MS,
  AUTO_UPDATE_IDLE_MS,
  AUTO_UPDATE_POLL_MS,
  runAutoUpdate,
  type AutoUpdatePort,
  type UpdateActivity,
} from "./autoUpdate";

function idle(idleMs: number, foreground = false, exporting = false): UpdateActivity {
  return { idleMs, foreground, exporting };
}

/** A clock the fake sleep advances, so idle readings line up with time. */
function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function port(overrides: Partial<AutoUpdatePort> = {}) {
  const calls: string[] = [];
  const base: AutoUpdatePort = {
    claim: async () => true,
    settle: async (consumed) => { calls.push(`settle:${consumed}`); },
    check: async () => true,
    download: async () => { calls.push("download"); },
    isEnabled: () => true,
    mayInstall: () => true,
    isStillAllowed: async () => true,
    activity: async () => idle(AUTO_UPDATE_IDLE_MS),
    now: () => 0,
    drain: async () => { calls.push("drain"); return true; },
    install: async () => { calls.push("install"); },
    sleep: async () => { calls.push("sleep"); },
    reportFailure: vi.fn(),
  };
  return { port: { ...base, ...overrides }, calls };
}

describe("runAutoUpdate — one attempt per logon", () => {
  it("does nothing, not even a check, for a later launch of the logon", async () => {
    const check = vi.fn(async () => true);
    const { port: p, calls } = port({ claim: async () => false, check });

    expect(await runAutoUpdate(p)).toBe("not-claimed");
    expect(check).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("treats a claim that cannot be made as not claimed", async () => {
    const { port: p } = port({ claim: async () => { throw new Error("no logon key"); } });

    expect(await runAutoUpdate(p)).toBe("not-claimed");
  });

  it("uses the logon's check up when there is nothing newer", async () => {
    const { port: p, calls } = port({ check: async () => false });

    expect(await runAutoUpdate(p)).toBe("up-to-date");
    expect(calls).toEqual(["settle:true"]);
  });

  it("gives the claim back when the check fails, as at a logon with no network yet", async () => {
    const { port: p, calls } = port({ check: async () => { throw new Error("offline"); } });

    expect(await runAutoUpdate(p)).toBe("check-failed");
    expect(calls).toEqual(["settle:false"]);
    expect(p.reportFailure).toHaveBeenCalledOnce();
  });

  it("gives the claim back when the download fails", async () => {
    const { port: p, calls } = port({ download: async () => { throw new Error("reset"); } });

    expect(await runAutoUpdate(p)).toBe("download-failed");
    expect(calls).toEqual(["settle:false"]);
  });

  it("downloads, drains and installs when idle, leaving the claim held", async () => {
    const { port: p, calls } = port();

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "drain", "install"]);
  });
});

describe("runAutoUpdate — never while the user is at the machine", () => {
  it("waits through input and installs only after the idle threshold", async () => {
    const idles = [0, 12_000, AUTO_UPDATE_IDLE_MS - 1, AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_IDLE_MS];
    const { port: p, calls } = port({ activity: async () => idle(idles.shift()!) });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "sleep", "sleep", "drain", "install"]);
  });

  it("goes back to waiting when input arrives during the drain", async () => {
    const idles = [AUTO_UPDATE_IDLE_MS, 0, AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_IDLE_MS];
    const { port: p, calls } = port({ activity: async () => idle(idles.shift()!) });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "drain", "sleep", "drain", "install"]);
  });

  it("holds off while the app must not be interrupted, however idle the user is", async () => {
    const gate = [false, false, true, true];
    const { port: p, calls } = port({ mayInstall: () => gate.shift()! });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "sleep", "drain", "install"]);
  });

  it("stops waiting and gives the claim back when the toggle is turned off", async () => {
    const enabled = [true, false];
    const { port: p, calls } = port({ isEnabled: () => enabled.shift()!, activity: async () => idle(0) });

    expect(await runAutoUpdate(p)).toBe("cancelled");
    expect(calls).toEqual(["download", "sleep", "settle:false"]);
    expect(p.reportFailure).not.toHaveBeenCalled();
  });
});

describe("runAutoUpdate — a Noten window in front", () => {
  it("waits a full minute of no input while Noten is the active window", async () => {
    const c = clock();
    const readings = [AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_FOREGROUND_IDLE_MS - 1, AUTO_UPDATE_FOREGROUND_IDLE_MS, AUTO_UPDATE_FOREGROUND_IDLE_MS];
    const { port: p, calls } = port({
      activity: async () => idle(readings.shift()!, true),
      now: c.now,
      sleep: async (ms) => { calls.push("sleep"); c.advance(ms); },
    });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "sleep", "drain", "install"]);
  });

  it("keeps the longer wait when another app takes focus without any input", async () => {
    const c = clock();
    // In front at the first reading, then a window that raised itself: the
    // idle stretch began while Noten was the active window.
    let t = 0;
    const { port: p, calls } = port({
      activity: async () => idle(20_000 + t, t === 0),
      now: c.now,
      sleep: async (ms) => { calls.push("sleep"); c.advance(ms); t += ms; },
    });

    expect(await runAutoUpdate(p)).toBe("installed");
    const waited = calls.filter((x) => x === "sleep").length * AUTO_UPDATE_POLL_MS;
    expect(20_000 + waited).toBeGreaterThanOrEqual(AUTO_UPDATE_FOREGROUND_IDLE_MS);
  });

  it("goes back to the background threshold once the user has moved to another app", async () => {
    const c = clock();
    // The click that moved focus away is input, so the idle stretch that
    // follows began with Noten in the background.
    const readings = [idle(AUTO_UPDATE_IDLE_MS, true), idle(0), idle(AUTO_UPDATE_IDLE_MS), idle(AUTO_UPDATE_IDLE_MS)];
    const { port: p, calls } = port({
      activity: async () => readings.shift()!,
      now: c.now,
      sleep: async () => { calls.push("sleep"); c.advance(AUTO_UPDATE_IDLE_MS); },
    });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "sleep", "drain", "install"]);
  });

  it("never installs during a PDF export, however idle", async () => {
    const readings = [idle(10 * AUTO_UPDATE_FOREGROUND_IDLE_MS, false, true), idle(AUTO_UPDATE_IDLE_MS), idle(AUTO_UPDATE_IDLE_MS)];
    const { port: p, calls } = port({ activity: async () => readings.shift()! });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "drain", "install"]);
  });
});

describe("runAutoUpdate — an opt-out made elsewhere", () => {
  it("does not install once the saved setting says off, and gives the claim back", async () => {
    const install = vi.fn(async () => {});
    const { port: p, calls } = port({ isStillAllowed: async () => false, install });

    expect(await runAutoUpdate(p)).toBe("cancelled");
    expect(install).not.toHaveBeenCalled();
    expect(calls).toEqual(["download", "drain", "settle:false"]);
  });

  it("treats a setting it cannot read as off", async () => {
    const install = vi.fn(async () => {});
    const { port: p } = port({ isStillAllowed: async () => { throw new Error("EBUSY"); }, install });

    expect(await runAutoUpdate(p)).toBe("cancelled");
    expect(install).not.toHaveBeenCalled();
  });
});

describe("runAutoUpdate — an unasked restart must not lose an edit", () => {
  it("does not install past a failed drain, and tries again slowly until one succeeds", async () => {
    const results = [false, false, true];
    const sleeps: number[] = [];
    const { port: p, calls } = port({
      drain: async () => results.shift()!,
      sleep: async (ms) => { sleeps.push(ms); },
    });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "install"]);
    expect(sleeps).toEqual([AUTO_UPDATE_DRAIN_RETRY_MS, AUTO_UPDATE_DRAIN_RETRY_MS]);
  });

  it("treats a drain that throws the same way", async () => {
    const results = [true];
    const { port: p, calls } = port({
      drain: async () => {
        if (results.shift()) throw new Error("EBUSY");
        return true;
      },
    });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "install"]);
  });

  it("can still be turned off while a drain keeps failing", async () => {
    const enabled = [true, false];
    const install = vi.fn(async () => {});
    const { port: p, calls } = port({ drain: async () => false, isEnabled: () => enabled.shift()!, install });

    expect(await runAutoUpdate(p)).toBe("cancelled");
    expect(install).not.toHaveBeenCalled();
    expect(calls).toEqual(["download", "sleep", "settle:false"]);
  });

  it("gives the claim back when the install fails", async () => {
    const { port: p, calls } = port({ install: async () => { throw new Error("bad signature"); } });

    expect(await runAutoUpdate(p)).toBe("install-failed");
    expect(calls).toEqual(["download", "drain", "settle:false"]);
  });
});
