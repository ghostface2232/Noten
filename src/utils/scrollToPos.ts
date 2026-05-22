/** Smooth-scroll the nearest scrollable ancestor when a target is near an edge. */
export function scrollToPos(
  dom: HTMLElement,
  getCoords: () => { top: number } | null,
) {
  requestAnimationFrame(() => {
    try {
      const coords = getCoords();
      if (!coords) return;
      let scrollParent: HTMLElement | null = dom.parentElement;
      while (scrollParent) {
        const { overflowY } = window.getComputedStyle(scrollParent);
        if (overflowY === "auto" || overflowY === "scroll") break;
        scrollParent = scrollParent.parentElement;
      }
      if (scrollParent) {
        const rect = scrollParent.getBoundingClientRect();
        const relativeTop = coords.top - rect.top;
        const padding = 80;
        if (relativeTop < padding || relativeTop > rect.height - padding) {
          scrollParent.scrollTo({
            top: scrollParent.scrollTop + relativeTop - rect.height / 3,
            behavior: "smooth",
          });
        }
      }
    } catch {}
  });
}
