import { describe, it, expect, vi } from "vitest";
import { AUTO_UPDATE_DRAIN_RETRY_MS, AUTO_UPDATE_IDLE_MS, runAutoUpdate, type AutoUpdatePort } from "./autoUpdate";

function port(overrides: Partial<AutoUpdatePort> = {}) {
  const calls: string[] = [];
  const base: AutoUpdatePort = {
    claim: async () => true,
    settle: async (consumed) => { calls.push(`settle:${consumed}`); },
    check: async () => true,
    download: async () => { calls.push("download"); },
    isEnabled: () => true,
    mayInstall: () => true,
    idleMs: async () => AUTO_UPDATE_IDLE_MS,
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
    const idle = [0, 12_000, AUTO_UPDATE_IDLE_MS - 1, AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_IDLE_MS];
    const { port: p, calls } = port({ idleMs: async () => idle.shift()! });

    expect(await runAutoUpdate(p)).toBe("installed");
    expect(calls).toEqual(["download", "sleep", "sleep", "sleep", "drain", "install"]);
  });

  it("goes back to waiting when input arrives during the drain", async () => {
    const idle = [AUTO_UPDATE_IDLE_MS, 0, AUTO_UPDATE_IDLE_MS, AUTO_UPDATE_IDLE_MS];
    const { port: p, calls } = port({ idleMs: async () => idle.shift()! });

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
    const { port: p, calls } = port({ isEnabled: () => enabled.shift()!, idleMs: async () => 0 });

    expect(await runAutoUpdate(p)).toBe("cancelled");
    expect(calls).toEqual(["download", "sleep", "settle:false"]);
    expect(p.reportFailure).not.toHaveBeenCalled();
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
