import { clampMenuToViewport } from "./clampMenuPosition";

/** Shared singleton for all context menus — ensures only one is open at a time. */
let activeMenu: HTMLElement | null = null;
let activeOverlay: HTMLElement | null = null;

export function closeContextMenu() {
  activeMenu?.remove();
  activeOverlay?.remove();
  activeMenu = null;
  activeOverlay = null;
}

export function registerContextMenu(menu: HTMLElement, overlay: HTMLElement) {
  closeContextMenu();
  activeMenu = menu;
  activeOverlay = overlay;
}

export function isDarkTheme(): boolean {
  return document.querySelector("[data-theme='dark']") !== null;
}

export function createMenuShell(pos: { x: number; y: number }, minWidth = 160): { menu: HTMLElement; overlay: HTMLElement } {
  closeContextMenu();
  const isDark = isDarkTheme();

  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:999;";
  overlay.addEventListener("mousedown", (e) => { e.preventDefault(); closeContextMenu(); });
  document.body.appendChild(overlay);

  const menu = document.createElement("div");
  menu.style.cssText = `
    position:fixed;z-index:1000;
    background:${isDark ? "var(--colorNeutralBackground1, #2b2b2b)" : "var(--colorNeutralBackground1, #fff)"};
    border:1px solid ${isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)"};
    box-shadow:${isDark ? "0 8px 32px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3)" : "0 8px 32px rgba(0,0,0,0.12),0 2px 8px rgba(0,0,0,0.06)"};
    border-radius:8px;padding:4px;min-width:${minWidth}px;
  `;
  menu.style.left = `${pos.x}px`;
  menu.style.top = `${pos.y}px`;

  document.body.appendChild(menu);
  registerContextMenu(menu, overlay);
  requestAnimationFrame(() => clampMenuToViewport(menu));

  return { menu, overlay };
}

export function createMenuItem(
  label: string,
  shortcut: string | null,
  opts: { danger?: boolean; disabled?: boolean },
): HTMLButtonElement {
  const isDark = isDarkTheme();
  const btn = document.createElement("button");
  btn.disabled = !!opts.disabled;

  const labelSpan = document.createElement("span");
  labelSpan.textContent = label;
  btn.appendChild(labelSpan);

  if (shortcut) {
    const keySpan = document.createElement("span");
    keySpan.textContent = shortcut;
    keySpan.style.cssText = "margin-left:auto;font-size:12px;opacity:0.45;padding-left:24px;";
    btn.appendChild(keySpan);
  }

  const textColor = opts.disabled
    ? (isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.3)")
    : opts.danger
      ? (isDark ? "#f87171" : "#c42b1c")
      : (isDark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)");

  btn.style.cssText = `
    display:flex;align-items:center;width:100%;text-align:left;border:none;
    border-radius:4px;font-size:13px;min-height:32px;padding:0 12px 0 8px;
    background:transparent;cursor:${opts.disabled ? "default" : "pointer"};
    font-family:inherit;color:${textColor};
  `;

  if (!opts.disabled) {
    btn.addEventListener("mouseenter", () => {
      btn.style.backgroundColor = isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.backgroundColor = "transparent";
    });
  }

  return btn;
}

export function createMenuSeparator(): HTMLElement {
  const isDark = isDarkTheme();
  const sep = document.createElement("div");
  sep.style.cssText = `height:1px;margin:4px 8px;background:${isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"};`;
  return sep;
}
