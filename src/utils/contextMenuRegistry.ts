import { clampMenuToViewport } from "./clampMenuPosition";
import { MOTION_DURATION_FAST } from "../styles/interactions";

/** Shared singleton for all context menus — ensures only one is open at a time. */
let activeMenu: HTMLElement | null = null;
let activeOverlay: HTMLElement | null = null;
/** Element that held focus before the menu opened, so it can be restored on close. */
let previouslyFocused: HTMLElement | null = null;
/** Document-level Escape listener, active only while a menu is open. */
let escKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Enabled, focusable menu items in DOM order. */
function focusableItems(menu: HTMLElement): HTMLElement[] {
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");
}

function removeActiveMenu(restoreFocus: boolean) {
  activeMenu?.remove();
  activeOverlay?.remove();
  activeMenu = null;
  activeOverlay = null;
  if (escKeyHandler) {
    document.removeEventListener("keydown", escKeyHandler, true);
    escKeyHandler = null;
  }
  // Return focus to whatever the user was on before opening the menu (usually
  // the editor), so keyboard focus is never stranded on a removed element.
  const toRestore = previouslyFocused;
  previouslyFocused = null;
  if (restoreFocus && toRestore?.isConnected) toRestore.focus();
}

export function closeContextMenu() {
  removeActiveMenu(true);
}

export function registerContextMenu(menu: HTMLElement, overlay: HTMLElement) {
  closeContextMenu();
  activeMenu = menu;
  activeOverlay = overlay;
}

export function isDarkTheme(): boolean {
  return document.querySelector("[data-theme='dark']") !== null;
}

export function createMenuShell(pos: { x: number; y: number }, minWidth = 160): { menu: HTMLElement; overlay: HTMLElement; isDark: boolean } {
  // Remember the element to return focus to on close. When swapping out an
  // already-open menu, keep its saved opener rather than the outgoing menu item
  // (which is about to be removed); otherwise remember the current focus. Tear
  // the old menu down WITHOUT restoring focus so this capture isn't clobbered.
  const opener = activeMenu
    ? previouslyFocused
    : (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  removeActiveMenu(false);

  const isDark = isDarkTheme();

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:999;";
  overlay.addEventListener("mousedown", (e) => { e.preventDefault(); closeContextMenu(); });
  document.body.appendChild(overlay);

  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-orientation", "vertical");
  menu.tabIndex = -1;
  menu.style.cssText = `
    position:fixed;z-index:1000;
    background:${isDark ? "var(--colorNeutralBackground1, #2b2b2b)" : "var(--colorNeutralBackground1, #fff)"};
    border:1px solid ${isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"};
    box-shadow:${isDark ? "0 8px 32px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3)" : "0 8px 32px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06)"};
    border-radius:8px;padding:4px;min-width:${minWidth}px;
  `;
  menu.style.left = `${pos.x}px`;
  menu.style.top = `${pos.y}px`;

  // Roving-focus keyboard navigation. Items are queried live because consumers
  // append them after this returns (same synchronous tick).
  menu.addEventListener("keydown", (e) => {
    const items = focusableItems(menu);
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        items[current < 0 ? 0 : (current + 1) % items.length].focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        items[current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length].focus();
        break;
      case "Home":
        e.preventDefault();
        items[0].focus();
        break;
      case "End":
        e.preventDefault();
        items[items.length - 1].focus();
        break;
      case "Tab":
        // A context menu is a focus endpoint: Tab dismisses it rather than
        // leaking focus into the page behind the overlay.
        e.preventDefault();
        closeContextMenu();
        break;
    }
  });

  document.body.appendChild(menu);
  if (typeof menu.animate === "function") {
    menu.animate(
      [
        { opacity: 0, transform: "translateY(4px)", filter: "blur(4px)" },
        { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
      ],
      { duration: 140, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }
  // registerContextMenu tears down any previously-open menu (and its Escape
  // listener), so wire up this menu's Escape handler *after* it, not before.
  registerContextMenu(menu, overlay);

  // Escape closes from anywhere, even if focus has drifted off the menu. Capture
  // phase + stopPropagation so it doesn't also reach app-level Escape handlers.
  escKeyHandler = (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();
  };
  document.addEventListener("keydown", escKeyHandler, true);

  // Record the opener last: registerContextMenu's internal teardown clears
  // previouslyFocused, so setting it earlier would be wiped before close.
  previouslyFocused = opener;

  requestAnimationFrame(() => {
    clampMenuToViewport(menu);
    // Items exist by now (appended synchronously by the caller); focus the first
    // enabled one so the menu is immediately keyboard-operable.
    focusableItems(menu)[0]?.focus();
  });

  return { menu, overlay, isDark };
}

export function createMenuItem(
  label: string,
  shortcut: string | null,
  opts: { danger?: boolean; disabled?: boolean; icon?: string; isDark?: boolean },
): HTMLButtonElement {
  const isDark = opts.isDark ?? isDarkTheme();
  const btn = document.createElement("button");
  btn.type = "button";
  btn.setAttribute("role", "menuitem");
  // Roving tabindex: the menu manages focus programmatically, so items stay out
  // of the document tab order.
  btn.tabIndex = -1;
  btn.disabled = !!opts.disabled;
  if (opts.disabled) btn.setAttribute("aria-disabled", "true");

  if (opts.icon) {
    const iconSpan = document.createElement("span");
    iconSpan.innerHTML = opts.icon;
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.style.cssText = "display:flex;align-items:center;flex-shrink:0;width:20px;height:20px;";
    btn.appendChild(iconSpan);
  }

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  btn.appendChild(labelSpan);

  if (shortcut) {
    const keySpan = document.createElement("span");
    keySpan.textContent = shortcut;
    keySpan.setAttribute("aria-hidden", "true");
    keySpan.style.cssText = "margin-left:auto;font-size:12px;opacity:0.45;padding-left:24px;white-space:nowrap;";
    btn.appendChild(keySpan);
  }

  const textColor = opts.disabled
    ? (isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)")
    : opts.danger
      ? (isDark ? "#f87171" : "#c42b1c")
      : (isDark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)");

  btn.style.cssText = `
    display:flex;align-items:center;width:100%;text-align:left;border:none;
    border-radius:4px;font-size:13px;font-weight:500;min-height:32px;padding:0 12px 0 8px;gap:8px;
    background:transparent;cursor:${opts.disabled ? "default" : "pointer"};
    font-family:inherit;color:${textColor};outline:none;
    transition:background-color ${MOTION_DURATION_FAST} ease-out,color ${MOTION_DURATION_FAST} ease-out,scale ${MOTION_DURATION_FAST} ease-out;
  `;

  if (!opts.disabled) {
    const highlight = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    // Mouse hover and keyboard focus share the same highlight so arrow-key
    // navigation is as visible as pointer hover.
    btn.addEventListener("mouseenter", () => { btn.style.backgroundColor = highlight; });
    btn.addEventListener("mouseleave", () => { btn.style.backgroundColor = "transparent"; });
    btn.addEventListener("focus", () => { btn.style.backgroundColor = highlight; });
    btn.addEventListener("blur", () => { btn.style.backgroundColor = "transparent"; });
    btn.addEventListener("mousedown", () => { btn.style.setProperty("scale", "0.96"); });
    btn.addEventListener("mouseup", () => { btn.style.setProperty("scale", "1"); });
    btn.addEventListener("mouseleave", () => { btn.style.setProperty("scale", "1"); });
    btn.addEventListener("blur", () => { btn.style.setProperty("scale", "1"); });
  }

  return btn;
}

export function createMenuSeparator(isDark?: boolean): HTMLElement {
  isDark = isDark ?? isDarkTheme();
  const sep = document.createElement("div");
  sep.setAttribute("role", "separator");
  sep.style.cssText = `height:1px;margin:4px 8px;background:${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"};`;
  return sep;
}
