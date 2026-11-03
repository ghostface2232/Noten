import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const refs = vi.hoisted(() => ({
  listeners: new Map<string, ((event: { payload: unknown }) => void)[]>(),
  windowLabels: ["main", "second"],
  enumerateThrows: false,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    refs.listeners.set(event, [...(refs.listeners.get(event) ?? []), handler]);
    return () => {
      refs.listeners.set(event, (refs.listeners.get(event) ?? []).filter((h) => h !== handler));
    };
  }),
  emit: vi.fn(async (event: string, payload: unknown) => {
    for (const handler of [...(refs.listeners.get(event) ?? [])]) handler({ payload });
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: "main" }),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getAllWebviewWindows: vi.fn(async () => {
    if (refs.enumerateThrows) throw new Error("enumeration failed");
    return refs.windowLabels.map((label) => ({ label }));
  }),
}));

import {
  drainPeerWindows,
  holdAndDrainPeerWindows,
  PEER_DRAIN_TIMEOUT_MS,
  PEER_HOLD_EXPIRY_MS,
  useUpdateDrainSync,
} from "./useUpdateDrainSync";
import { emit } from "@tauri-apps/api/event";

/** Plays another window answering a request, since all of these share a label. */
function answerAs(label: string, ok: boolean | undefined) {
  refs.listeners.set("update-drain-request", [
    ...(refs.listeners.get("update-drain-request") ?? []),
    (event) => {
      const { drainId } = event.payload as { drainId: string };
      void emit("update-drain-ack", { sourceWindow: label, drainId, ok });
    },
  ]);
}

beforeEach(() => {
  refs.listeners.clear();
  refs.windowLabels = ["main", "second"];
  refs.enumerateThrows = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("drainPeerWindows", () => {
  it("has nothing to confirm when this is the only window", async () => {
    refs.windowLabels = ["main"];
    expect(await drainPeerWindows()).toBe(true);
  });

  it("confirms only once every other window acked ok", async () => {
    refs.windowLabels = ["main", "second", "third"];
    answerAs("second", true);
    answerAs("third", true);
    expect(await drainPeerWindows()).toBe(true);
  });

  it("fails when one window could not protect its edits", async () => {
    refs.windowLabels = ["main", "second", "third"];
    answerAs("second", true);
    answerAs("third", false);
    expect(await drainPeerWindows()).toBe(false);
  });

  it("does not take a missing status for success", async () => {
    answerAs("second", undefined);
    expect(await drainPeerWindows()).toBe(false);
  });

  it("fails when a window never answers", async () => {
    vi.useFakeTimers();
    const result = drainPeerWindows();
    await vi.advanceTimersByTimeAsync(PEER_DRAIN_TIMEOUT_MS);
    expect(await result).toBe(false);
  });

  it("fails when the windows cannot be listed", async () => {
    refs.enumerateThrows = true;
    expect(await drainPeerWindows()).toBe(false);
  });

  it("ignores an ack from another drain", async () => {
    vi.useFakeTimers();
    const result = drainPeerWindows();
    await vi.advanceTimersByTimeAsync(0);
    await emit("update-drain-ack", { sourceWindow: "second", drainId: "stale", ok: true });
    await vi.advanceTimersByTimeAsync(PEER_DRAIN_TIMEOUT_MS);
    expect(await result).toBe(false);
  });
});

describe("useUpdateDrainSync", () => {
  async function requestDrain(sourceWindow = "second", holdInput = false) {
    const acks: { ok: boolean }[] = [];
    refs.listeners.set("update-drain-ack", [(event) => { acks.push(event.payload as { ok: boolean }); }]);
    await act(async () => {
      await emit("update-drain-request", { sourceWindow, drainId: "d", holdInput });
    });
    return acks;
  }

  const holdState = { held: 0, refuse: false };
  const holdInputRef = {
    current: () => {
      if (holdState.refuse) return null;
      holdState.held++;
      let released = false;
      return () => {
        if (!released) holdState.held--;
        released = true;
      };
    },
  };

  async function mount(drain: () => Promise<boolean>, mayInstall = () => true) {
    holdState.held = 0;
    holdState.refuse = false;
    const drainRef = { current: drain };
    const view = renderHook(() => useUpdateDrainSync({ drainRef, holdInputRef, mayInstall }));
    await act(async () => {});
    return view;
  }

  it("runs this window's drain and reports its answer", async () => {
    const drain = vi.fn(async () => true);
    await mount(drain);

    expect((await requestDrain()).map((a) => a.ok)).toEqual([true]);
    expect(drain).toHaveBeenCalledOnce();
  });

  it("reports a failed drain", async () => {
    await mount(async () => false);

    expect((await requestDrain()).map((a) => a.ok)).toEqual([false]);
  });

  it("reports a drain that throws as failed", async () => {
    await mount(async () => { throw new Error("EBUSY"); });

    expect((await requestDrain()).map((a) => a.ok)).toEqual([false]);
  });

  it("refuses without draining while this window must not be interrupted", async () => {
    const drain = vi.fn(async () => true);
    await mount(drain, () => false);

    expect((await requestDrain()).map((a) => a.ok)).toEqual([false]);
    expect(drain).not.toHaveBeenCalled();
  });

  it("does not answer its own request", async () => {
    const drain = vi.fn(async () => true);
    await mount(drain);

    expect(await requestDrain("main")).toEqual([]);
    expect(drain).not.toHaveBeenCalled();
  });

  it("holds input before the last drain and keeps holding until released", async () => {
    let heldDuringDrain = false;
    await mount(async () => { heldDuringDrain = holdState.held === 1; return true; });

    expect((await requestDrain("second", true)).map((a) => a.ok)).toEqual([true]);
    expect(heldDuringDrain).toBe(true);
    expect(holdState.held).toBe(1);
    await act(async () => { await emit("update-drain-release", { drainId: "other" }); });
    expect(holdState.held).toBe(1);
    await act(async () => { await emit("update-drain-release", { drainId: "d" }); });
    expect(holdState.held).toBe(0);
  });

  it("lets go at once when its held drain fails", async () => {
    await mount(async () => false);

    expect((await requestDrain("second", true)).map((a) => a.ok)).toEqual([false]);
    expect(holdState.held).toBe(0);
  });

  it("refuses when its input cannot be held, as mid-composition", async () => {
    const drain = vi.fn(async () => true);
    await mount(drain);
    holdState.refuse = true;

    expect((await requestDrain("second", true)).map((a) => a.ok)).toEqual([false]);
    expect(drain).not.toHaveBeenCalled();
  });

  it("lets go on its own if the requester never releases it", async () => {
    vi.useFakeTimers();
    await mount(async () => true);

    await requestDrain("second", true);
    expect(holdState.held).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEER_HOLD_EXPIRY_MS); });
    expect(holdState.held).toBe(0);
  });

  it("lets go on its own when its held drain hangs and the requester is gone", async () => {
    vi.useFakeTimers();
    await mount(() => new Promise<boolean>(() => {}));

    const acks = await requestDrain("second", true);
    expect(holdState.held).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(PEER_DRAIN_TIMEOUT_MS); });
    expect(holdState.held).toBe(0);
    expect(acks.map((a) => a.ok)).toEqual([false]);
  });

  it("lets go when the window unmounts", async () => {
    const view = await mount(async () => true);

    await requestDrain("second", true);
    view.unmount();
    expect(holdState.held).toBe(0);
  });
});

describe("holdAndDrainPeerWindows", () => {
  function releases() {
    const ids: string[] = [];
    refs.listeners.set("update-drain-release", [(event) => { ids.push((event.payload as { drainId: string }).drainId); }]);
    return ids;
  }

  it("asks every window to hold, and releases them on request", async () => {
    let asked: unknown;
    refs.listeners.set("update-drain-request", [(event) => { asked = event.payload; }]);
    answerAs("second", true);
    const released = releases();

    const hold = await holdAndDrainPeerWindows();
    expect(hold.ok).toBe(true);
    expect(asked).toMatchObject({ holdInput: true });
    expect(released).toEqual([]);
    await hold.release();
    expect(released).toHaveLength(1);
  });

  it("releases every window itself when one did not confirm", async () => {
    refs.windowLabels = ["main", "second", "third"];
    answerAs("second", true);
    answerAs("third", false);
    const released = releases();

    expect((await holdAndDrainPeerWindows()).ok).toBe(false);
    expect(released).toHaveLength(1);
  });

  it("releases a window that answered too late", async () => {
    vi.useFakeTimers();
    const released = releases();
    const result = holdAndDrainPeerWindows();
    await vi.advanceTimersByTimeAsync(PEER_DRAIN_TIMEOUT_MS);

    expect((await result).ok).toBe(false);
    expect(released).toHaveLength(1);
  });

  it("a plain drain never asks for a hold", async () => {
    let asked: unknown;
    refs.listeners.set("update-drain-request", [(event) => { asked = event.payload; }]);
    answerAs("second", true);

    expect(await drainPeerWindows()).toBe(true);
    expect(asked).toMatchObject({ holdInput: false });
  });
});
