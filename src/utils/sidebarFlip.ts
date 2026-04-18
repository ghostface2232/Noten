// FLIP helper for sidebar row reorder animations. Used by both group
// reorder and note drag commits: snapshot each row's top before the state
// change, then call `playSidebarRowsFLIP(oldTops)` right after flushSync so
// the new DOM is placed back at its pre-commit position via transform and
// glides to its new position on the next frame.

const REORDER_ANIM_MS = 280;
const REORDER_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

function collectRowTops(section: HTMLElement, map: Map<string, number>): void {
  section.querySelectorAll<HTMLElement>("[data-group-item][data-group-id]").forEach((el) => {
    const id = el.dataset.groupId;
    if (id) map.set(`g:${id}`, el.getBoundingClientRect().top);
  });
  section.querySelectorAll<HTMLElement>("[data-doc-item][data-note-id]").forEach((el) => {
    const id = el.dataset.noteId;
    if (id) map.set(`n:${id}`, el.getBoundingClientRect().top);
  });
}

export function captureSidebarRowTops(): Map<string, number> {
  const map = new Map<string, number>();
  const groupsSection = document.querySelector<HTMLElement>("[data-groups-section]");
  const notesSection = document.querySelector<HTMLElement>("[data-notes-section]");
  if (groupsSection) collectRowTops(groupsSection, map);
  if (notesSection) collectRowTops(notesSection, map);
  return map;
}

export function playSidebarRowsFLIP(oldTops: Map<string, number>): void {
  const newTops = captureSidebarRowTops();
  const targets: HTMLElement[] = [];

  for (const [key, oldTop] of oldTops) {
    const newTop = newTops.get(key);
    if (newTop === undefined) continue;
    const dy = oldTop - newTop;
    if (Math.abs(dy) < 0.5) continue;

    const type = key.slice(0, 1);
    const id = key.slice(2);
    const selector = type === "g"
      ? `[data-group-item][data-group-id="${CSS.escape(id)}"]`
      : `[data-doc-item][data-note-id="${CSS.escape(id)}"]`;
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;

    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    targets.push(el);
  }

  if (targets.length === 0) return;

  // Force the inverse transform to flush before the next paint so the
  // transition kicks in from the old visual position rather than the new.
  for (const el of targets) void el.offsetHeight;

  requestAnimationFrame(() => {
    for (const el of targets) {
      el.style.transition = `transform ${REORDER_ANIM_MS}ms ${REORDER_EASING}`;
      el.style.transform = "";
    }
    window.setTimeout(() => {
      for (const el of targets) {
        el.style.transition = "";
        el.style.transform = "";
      }
    }, REORDER_ANIM_MS + 40);
  });
}
