import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

const refs = vi.hoisted(() => ({ log: "" }));

vi.mock("@tauri-apps/api/path", () => ({ appDataDir: vi.fn(async () => "/appdata") }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => {}),
  exists: vi.fn(async () => refs.log !== ""),
  readTextFile: vi.fn(async () => refs.log),
  writeTextFile: vi.fn(async (_path: string, text: string) => { refs.log = text; }),
}));

import { initCrashLog, logNotenError } from "./crashLog";
import { NotenError, registerFatalHandler } from "./notenError";

const settle = () => logNotenError(new NotenError("SAVE_FAILED", "recoverable", "marker"));

function dispatchError(init: ErrorEventInit) {
  window.dispatchEvent(new ErrorEvent("error", init));
}

function dispatchRejection(reason: unknown) {
  const event = new Event("unhandledrejection") as Event & { reason: unknown };
  event.reason = reason;
  window.dispatchEvent(event);
}

describe("uncaught errors", () => {
  const shown: NotenError[] = [];

  beforeAll(() => initCrashLog());

  beforeEach(() => {
    refs.log = "";
    shown.length = 0;
    registerFatalHandler((error) => shown.push(error));
  });

  afterEach(() => registerFatalHandler(null));

  it("shows an uncaught error and logs it", async () => {
    dispatchError({ error: new Error("boom"), message: "boom" });
    await settle();

    expect(shown.map((error) => [error.code, error.message])).toEqual([["UNCAUGHT", "boom"]]);
    expect(refs.log).toContain("boom");
  });

  it("shows a rejection nothing handled", async () => {
    dispatchRejection(new Error("rejected"));
    await settle();

    expect(shown.map((error) => error.message)).toEqual(["rejected"]);
    expect(refs.log).toContain("rejected");
  });

  it("shows a rejection with a plain string, as IPC errors are", async () => {
    dispatchRejection("forbidden path");
    await settle();

    expect(shown.map((error) => error.message)).toEqual(["forbidden path"]);
  });

  it("neither shows nor logs a ResizeObserver loop", async () => {
    dispatchError({ error: null, message: "ResizeObserver loop completed with undelivered notifications." });
    await settle();

    expect(shown).toEqual([]);
    expect(refs.log).not.toContain("UNCAUGHT");
  });

  it("logs the message of an error event with nothing thrown, and does not show it", async () => {
    dispatchError({ error: null, message: "Script error." });
    await settle();

    expect(shown).toEqual([]);
    expect(refs.log).toContain("Script error.");
    expect(refs.log).not.toMatch(/UNCAUGHT.*null/);
  });

  it("does not show a NotenError twice or log it as uncaught", async () => {
    dispatchError({ error: new NotenError("SAVE_FAILED", "fatal", "disk"), message: "disk" });
    await settle();

    expect(shown.map((error) => error.code)).toEqual(["SAVE_FAILED"]);
    expect(refs.log).not.toContain("UNCAUGHT");
  });
});
