import { describe, it, expect, afterEach } from "vitest";
import {
  createMenuShell,
  createMenuItem,
  createMenuSeparator,
  closeContextMenu,
} from "./contextMenuRegistry";

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function dispatchKey(target: EventTarget, key: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

/** Build a menu with three items (middle one disabled) and return the shell + buttons. */
function buildMenu() {
  const { menu } = createMenuShell({ x: 0, y: 0 });
  const a = createMenuItem("A", null, {});
  const b = createMenuItem("B", null, { disabled: true });
  const c = createMenuItem("C", null, {});
  menu.append(a, createMenuSeparator(), b, c);
  return { menu, a, b, c };
}

afterEach(() => {
  closeContextMenu();
  document.body.innerHTML = "";
});

describe("contextMenuRegistry — ARIA roles", () => {
  it("marks the menu, items and separator with menu roles", () => {
    const { menu, a, b } = buildMenu();
    expect(menu.getAttribute("role")).toBe("menu");
    expect(menu.getAttribute("aria-orientation")).toBe("vertical");
    expect(a.getAttribute("role")).toBe("menuitem");
    expect(a.tabIndex).toBe(-1);
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect(menu.querySelector('[role="separator"]')).not.toBeNull();
  });
});

describe("contextMenuRegistry — keyboard navigation", () => {
  it("focuses the first enabled item once mounted", async () => {
    const { a } = buildMenu();
    await nextFrame();
    expect(document.activeElement).toBe(a);
  });

  it("ArrowDown skips disabled items and wraps around", () => {
    const { a, c } = buildMenu();
    a.focus();
    dispatchKey(a, "ArrowDown");
    expect(document.activeElement).toBe(c); // B is disabled, skipped
    dispatchKey(c, "ArrowDown");
    expect(document.activeElement).toBe(a); // wraps back to first
  });

  it("ArrowUp moves to the previous enabled item", () => {
    const { a, c } = buildMenu();
    a.focus();
    dispatchKey(a, "ArrowUp");
    expect(document.activeElement).toBe(c);
  });

  it("Home / End jump to the first / last enabled item", () => {
    const { menu, a, c } = buildMenu();
    c.focus();
    dispatchKey(menu, "Home");
    expect(document.activeElement).toBe(a);
    dispatchKey(menu, "End");
    expect(document.activeElement).toBe(c);
  });
});

describe("contextMenuRegistry — dismissal", () => {
  it("Escape from anywhere closes the menu", () => {
    const { menu } = buildMenu();
    expect(document.body.contains(menu)).toBe(true);
    // Dispatched from an element outside the menu — the document-level capture
    // handler must still catch it.
    const event = dispatchKey(document.body, "Escape");
    expect(document.body.contains(menu)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it("Tab dismisses the menu instead of leaking focus behind the overlay", () => {
    const { menu, a } = buildMenu();
    a.focus();
    dispatchKey(a, "Tab");
    expect(document.body.contains(menu)).toBe(false);
  });

  it("restores focus to the previously focused element on close", async () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    buildMenu();
    await nextFrame();
    expect(document.activeElement).not.toBe(trigger);

    closeContextMenu();
    expect(document.activeElement).toBe(trigger);
  });

  it("opening a second menu removes the first (single active menu)", () => {
    const { menu: first } = buildMenu();
    const { menu: second } = createMenuShell({ x: 10, y: 10 });
    expect(document.body.contains(first)).toBe(false);
    expect(document.body.contains(second)).toBe(true);
  });
});
