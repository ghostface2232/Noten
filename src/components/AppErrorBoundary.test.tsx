import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const refs = vi.hoisted(() => ({ show: vi.fn(async () => {}), logged: vi.fn(async () => {}) }));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ show: refs.show }) }));
vi.mock("../utils/crashLog", () => ({ logNotenError: refs.logged }));

import { AppErrorBoundary } from "./AppErrorBoundary";

function Throws(): never {
  throw new Error("render failed");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refs.show.mockClear();
  refs.logged.mockClear();
});

describe("AppErrorBoundary", () => {
  it("renders its children when nothing fails", () => {
    render(<AppErrorBoundary><p>note</p></AppErrorBoundary>);

    expect(screen.getByText("note")).toBeTruthy();
    expect(refs.logged).not.toHaveBeenCalled();
  });

  it("replaces an empty window with a way back, shows the window and logs the cause", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<AppErrorBoundary><Throws /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(refs.show).toHaveBeenCalled();
    expect(refs.logged).toHaveBeenCalledWith(
      expect.objectContaining({ code: "UNCAUGHT", severity: "fatal", message: "render failed" }),
    );
  });
});
