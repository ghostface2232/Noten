import { type Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";

export function startReorder(
  editor: Editor,
  nodePos: number,
  nodeSize: number,
  attrs: Record<string, unknown>,
  imgEl: HTMLImageElement,
  event: PointerEvent,
): void {
  const imgRect = imgEl.getBoundingClientRect();
  const scale = 0.85;
  const ghostW = imgRect.width * scale;
  const ghostH = imgRect.height * scale;
  const offsetX = (event.clientX - imgRect.left) * scale;
  const offsetY = (event.clientY - imgRect.top) * scale;

  const ghost = document.createElement("div");
  ghost.className = "image-drag-ghost";
  ghost.style.left = "0";
  ghost.style.top = "0";
  ghost.style.transform = `translate3d(${event.clientX - offsetX}px, ${event.clientY - offsetY}px, 0)`;
  const ghostImg = document.createElement("img");
  ghostImg.src = attrs.src as string;
  ghostImg.style.width = `${ghostW}px`;
  ghostImg.style.height = `${ghostH}px`;
  ghost.appendChild(ghostImg);
  document.body.appendChild(ghost);

  imgEl.style.opacity = "0.3";
  document.body.style.cursor = "move";

  const indicator = document.createElement("div");
  indicator.className = "image-drop-indicator";
  indicator.style.left = "0";
  indicator.style.top = "0";
  document.body.appendChild(indicator);

  const pmDom = editor.view.dom;
  const pmRect = pmDom.getBoundingClientRect();
  const pmStyle = getComputedStyle(pmDom);
  const paddingLeft = parseFloat(pmStyle.paddingLeft);
  const paddingRight = parseFloat(pmStyle.paddingRight);
  const contentLeft = pmRect.left + paddingLeft;
  const contentWidth = pmRect.width - paddingLeft - paddingRight;

  let pendingX = event.clientX;
  let pendingY = event.clientY;
  let rafId: number | null = null;
  let lastInsertPos: number | null = null;
  let currentInsertPos: number | null = null;
  let cleaned = false;

  let scrollContainer: HTMLElement | null = null;
  let ancestor = imgEl.parentElement;
  while (ancestor) {
    if (ancestor instanceof HTMLElement) {
      const ov = getComputedStyle(ancestor).overflowY;
      if (ov === "auto" || ov === "scroll") {
        scrollContainer = ancestor;
        break;
      }
    }
    ancestor = ancestor.parentElement;
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    ghost.remove();
    indicator.remove();
    imgEl.style.opacity = "";
    document.body.style.cursor = "";
    if (rafId !== null) cancelAnimationFrame(rafId);
    document.removeEventListener("pointermove", onPointerMove);
    document.removeEventListener("pointerup", onPointerUp);
    document.removeEventListener("keydown", onKeyDown);
  }

  function tick() {
    rafId = null;
    let isScrolling = false;

    ghost.style.transform = `translate3d(${pendingX - offsetX}px, ${pendingY - offsetY}px, 0)`;

    try {
      const posResult = editor.view.posAtCoords({ left: pendingX, top: pendingY });
      if (!posResult) {
        indicator.style.opacity = "0";
        currentInsertPos = null;
      } else {
        const $resolved = editor.state.doc.resolve(posResult.pos);
        const blockStart = $resolved.before(1);
        const blockEnd = $resolved.after(1);

        const blockDOM = editor.view.nodeDOM(blockStart) as HTMLElement | null;
        if (!blockDOM || !(blockDOM instanceof HTMLElement)) {
          indicator.style.opacity = "0";
          currentInsertPos = null;
        } else {
          const blockRect = blockDOM.getBoundingClientRect();
          const midY = (blockRect.top + blockRect.bottom) / 2;

          const prevSibling = blockDOM.previousElementSibling as HTMLElement | null;
          const nextSibling = blockDOM.nextElementSibling as HTMLElement | null;

          let insertPos: number;
          let indicatorY: number;

          if (pendingY < midY) {
            insertPos = blockStart;
            if (prevSibling) {
              indicatorY = (prevSibling.getBoundingClientRect().bottom + blockRect.top) / 2;
            } else {
              indicatorY = blockRect.top;
            }
          } else {
            insertPos = blockEnd;
            if (nextSibling) {
              indicatorY = (blockRect.bottom + nextSibling.getBoundingClientRect().top) / 2;
            } else {
              indicatorY = blockRect.bottom;
            }
          }

          if (insertPos === nodePos || insertPos === nodePos + nodeSize) {
            indicator.style.opacity = "0";
            currentInsertPos = null;
          } else {
            if (lastInsertPos !== insertPos) {
              indicator.style.left = contentLeft + "px";
              indicator.style.width = contentWidth + "px";
              indicator.style.top = indicatorY - 1 + "px";
              indicator.style.opacity = "1";
              lastInsertPos = insertPos;
            }
            currentInsertPos = insertPos;
          }
        }
      }
    } catch {
      indicator.style.opacity = "0";
      currentInsertPos = null;
    }

    if (scrollContainer) {
      const scrollRect = scrollContainer.getBoundingClientRect();
      const EDGE = 40;
      const MAX_SPEED = 12;

      const distTop = pendingY - scrollRect.top;
      if (distTop < EDGE) {
        scrollContainer.scrollBy({ top: -(((EDGE - distTop) / EDGE) * MAX_SPEED), behavior: "instant" as ScrollBehavior });
        isScrolling = true;
      }

      const distBottom = scrollRect.bottom - pendingY;
      if (distBottom < EDGE) {
        scrollContainer.scrollBy({ top: ((EDGE - distBottom) / EDGE) * MAX_SPEED, behavior: "instant" as ScrollBehavior });
        isScrolling = true;
      }

      if (isScrolling && rafId === null) {
        rafId = requestAnimationFrame(tick);
      }
    }
  }

  const onPointerMove = (ev: PointerEvent) => {
    pendingX = ev.clientX;
    pendingY = ev.clientY;
    if (rafId === null) {
      rafId = requestAnimationFrame(tick);
    }
    ev.preventDefault();
  };

  const onPointerUp = () => {
    if (currentInsertPos !== null) {
      const imageNode = editor.schema.nodes.image!.create(attrs);
      const tr = editor.view.state.tr;

      tr.delete(nodePos, nodePos + nodeSize);

      let adjustedPos = currentInsertPos;
      if (currentInsertPos > nodePos) {
        adjustedPos -= nodeSize;
      }

      tr.insert(adjustedPos, imageNode);
      tr.setSelection(NodeSelection.create(tr.doc, adjustedPos));
      editor.view.dispatch(tr.scrollIntoView());
    }
    cleanup();
  };

  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      cleanup();
    }
  };

  document.addEventListener("pointermove", onPointerMove);
  document.addEventListener("pointerup", onPointerUp);
  document.addEventListener("keydown", onKeyDown);
}
