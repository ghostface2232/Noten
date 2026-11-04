import { describe, it, expect, vi, afterEach } from "vitest";
import { createElement, type ComponentProps } from "react";
import { render, screen, cleanup } from "@testing-library/react";

const refs = vi.hoisted(() => ({
  show: vi.fn(async () => {}),
  logged: vi.fn(async () => {}),
  fluentBroken: false,
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ show: refs.show }) }));
vi.mock("../utils/crashLog", () => ({ logNotenError: refs.logged }));
vi.mock("@fluentui/react-components", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fluentui/react-components")>();
  return {
    ...actual,
    FluentProvider: (props: ComponentProps<typeof actual.FluentProvider>) => {
      if (refs.fluentBroken) throw new Error("fluent failed");
      return createElement(actual.FluentProvider, props);
    },
  };
});

import { AppErrorBoundary } from "./AppErrorBoundary";

function Throws(): never {
  throw new Error("render failed");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refs.show.mockClear();
  refs.logged.mockClear();
  refs.fluentBroken = false;
});

describe("AppErrorBoundary", () => {
  it("renders its children when nothing fails", () => {
    render(<AppErrorBoundary><p>note</p></AppErrorBoundary>);

    expect(screen.getByText("note")).toBeTruthy();
    expect(refs.logged).not.toHaveBeenCalled();
  });

  it("replaces an empty window with Fluent controls, shows the window and logs the cause", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    render(<AppErrorBoundary><Throws /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.className).toContain("fui-Button");
    expect(refs.show).toHaveBeenCalled();
    expect(refs.logged).toHaveBeenCalledWith(
      expect.objectContaining({ code: "UNCAUGHT", severity: "fatal", message: "render failed" }),
    );
  });

  it("still leaves a way out when Fluent itself is what failed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    refs.fluentBroken = true;

    render(<AppErrorBoundary><Throws /></AppErrorBoundary>);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(refs.logged).toHaveBeenCalledWith(expect.objectContaining({ message: "fluent failed" }));
  });
});
