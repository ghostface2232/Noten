import { type Editor } from "@tiptap/core";
import { startReorder } from "./ImageReorder";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { dataUrlToUint8Array, mimeToExt, bytesToDataUrl, mimeFromExt } from "../utils/imageUtils";
import { closeContextMenu, createMenuShell, createMenuItem } from "../utils/contextMenuRegistry";

const HANDLE_SIZE = 10;
const HANDLE_HIT = 20;
const MIN_WIDTH = 60;

function showContextMenu(
  pos: { x: number; y: number },
  editor: Editor,
  nodePos: number,
  src: string,
  locale: Locale,
) {
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const { menu } = createMenuShell(pos, 160);

  // Fluent UI 20px regular icons (extracted from @fluentui/react-icons)
  const iconSave = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M3 5c0-1.1.9-2 2-2h8.38a2 2 0 0 1 1.41.59l1.62 1.62A2 2 0 0 1 17 6.62V15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm2-1a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1v-4.5c0-.83.67-1.5 1.5-1.5h7c.83 0 1.5.67 1.5 1.5V16a1 1 0 0 0 1-1V6.62a1 1 0 0 0-.3-.7L14.1 4.28a1 1 0 0 0-.71-.29H13v2.5c0 .83-.67 1.5-1.5 1.5h-4A1.5 1.5 0 0 1 6 6.5V4H5Zm2 0v2.5c0 .28.22.5.5.5h4a.5.5 0 0 0 .5-.5V4H7Zm7 12v-4.5a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5V16h8Z"/></svg>';
  const iconCopy = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M8 2a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h6a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8ZM7 4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4ZM4 6a2 2 0 0 1 1-1.73V14.5A2.5 2.5 0 0 0 7.5 17h6.23A2 2 0 0 1 12 18H7.5A3.5 3.5 0 0 1 4 14.5V6Z"/></svg>';
  const iconReplace = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M12.15 3.15c.2-.2.5-.2.7 0l3 3c.2.2.2.5 0 .7l-3 3a.5.5 0 0 1-.7-.7L14.29 7H4.5a.5.5 0 0 1 0-1h9.8l-2.15-2.15a.5.5 0 0 1 0-.7Zm-4.3 7c.2.2.2.5 0 .7L5.71 13h9.79a.5.5 0 0 1 0 1H5.7l2.15 2.15a.5.5 0 0 1-.7.7l-3-3a.5.5 0 0 1 0-.7l3-3c.2-.2.5-.2.7 0Z"/></svg>';
  const iconDelete = '<svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path d="M8.5 4h3a1.5 1.5 0 0 0-3 0Zm-1 0a2.5 2.5 0 0 1 5 0h5a.5.5 0 0 1 0 1h-1.05l-1.2 10.34A3 3 0 0 1 12.27 18H7.73a3 3 0 0 1-2.98-2.66L3.55 5H2.5a.5.5 0 0 1 0-1h5ZM5.74 15.23A2 2 0 0 0 7.73 17h4.54a2 2 0 0 0 1.99-1.77L15.44 5H4.56l1.18 10.23ZM8.5 7.5c.28 0 .5.22.5.5v6a.5.5 0 0 1-1 0V8c0-.28.22-.5.5-.5ZM12 8a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V8Z"/></svg>';

  const items: { label: string; icon: string; danger?: boolean; action: () => void }[] = [
    {
      label: i("image.save"), icon: iconSave,
      action: async () => {
        closeContextMenu();
        const ext = mimeToExt(src);
        const path = await save({ title: i("dialog.saveImage"), filters: [{ name: "Image", extensions: [ext] }] });
        if (!path) return;
        await writeFile(path, dataUrlToUint8Array(src));
      },
    },
    {
      label: i("image.copy"), icon: iconCopy,
      action: async () => {
        closeContextMenu();
        try {
          const bytes = dataUrlToUint8Array(src);
          const mime = src.split(",")[0].split(":")[1].split(";")[0];
          const blob = new Blob([bytes], { type: mime });
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        } catch { /* ignore */ }
      },
    },
    {
      label: i("image.replace"), icon: iconReplace,
      action: async () => {
        closeContextMenu();
        const selected = await open({
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] }],
          multiple: false,
        });
        if (!selected) return;
        const path = selected as string;
        const ext = path.split(".").pop() ?? "png";
        const fileBytes = await readFile(path);
        const dataUrl = bytesToDataUrl(fileBytes, mimeFromExt(ext));
        editor.chain().focus().setNodeSelection(nodePos).updateAttributes("image", { src: dataUrl }).run();
      },
    },
    {
      label: i("image.delete"), icon: iconDelete,
      danger: true,
      action: () => {
        closeContextMenu();
        editor.chain().focus().setNodeSelection(nodePos).deleteSelection().run();
      },
    },
  ];

  items.forEach((item) => {
    const btn = createMenuItem(item.label, null, { danger: item.danger, icon: item.icon });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); item.action(); });
    menu.appendChild(btn);
  });
}

export function createImageNodeView(editor: Editor) {
  return (props: { node: any; getPos: () => number | undefined; HTMLAttributes: Record<string, any> }) => {
    const { node, getPos, HTMLAttributes } = props;

    let currentSrc = node.attrs.src;
    let currentNode = node;
    let activeDragCleanup: (() => void) | null = null;

    const dom = document.createElement("div");
    dom.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0;";
    dom.draggable = false;

    const img = document.createElement("img");
    img.src = HTMLAttributes.src;
    if (HTMLAttributes.alt) img.alt = HTMLAttributes.alt;
    if (HTMLAttributes.title) img.title = HTMLAttributes.title;
    img.draggable = false;
    img.style.cssText = "display:block;max-width:100%;height:auto;border-radius:var(--editor-radius);cursor:default;";
    if (HTMLAttributes.width) img.style.width = `${HTMLAttributes.width}px`;
    if (HTMLAttributes.height) img.style.height = `${HTMLAttributes.height}px`;
    dom.appendChild(img);

    const handles: HTMLElement[] = [];
    const corners = ["nw", "ne", "sw", "se"] as const;
    const cursorMap = { nw: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", se: "nwse-resize" };

    corners.forEach((corner) => {
      const hitArea = document.createElement("div");
      hitArea.dataset.corner = corner;
      hitArea.style.cssText = `
        position:absolute;width:${HANDLE_HIT}px;height:${HANDLE_HIT}px;
        cursor:${cursorMap[corner]};z-index:1;
        opacity:0;pointer-events:none;
        display:flex;align-items:center;justify-content:center;
      `;
      if (corner.includes("n")) hitArea.style.top = `-${HANDLE_HIT / 2}px`;
      if (corner.includes("s")) hitArea.style.bottom = `-${HANDLE_HIT / 2}px`;
      if (corner.includes("w")) hitArea.style.left = `-${HANDLE_HIT / 2}px`;
      if (corner.includes("e")) hitArea.style.right = `-${HANDLE_HIT / 2}px`;
      const knob = document.createElement("div");
      knob.style.cssText = `
        width:${HANDLE_SIZE}px;height:${HANDLE_SIZE}px;
        background:#fff;border:1.5px solid var(--editor-color-accent, #0078d4);
        border-radius:2px;pointer-events:none;
      `;
      hitArea.appendChild(knob);
      dom.appendChild(hitArea);
      handles.push(hitArea);
    });

    const isReadonly = () => !!editor.storage.readonlyGuard?.readonly;

    const syncDragState = () => {
      img.style.cursor = isReadonly() ? "default" : "move";
    };

    const showHandles = () => {
      if (isReadonly()) return;
      handles.forEach((h) => { h.style.opacity = "1"; h.style.pointerEvents = "auto"; });
    };
    const hideHandles = () => handles.forEach((h) => { h.style.opacity = "0"; h.style.pointerEvents = "none"; });
    dom.addEventListener("mouseenter", showHandles);
    dom.addEventListener("mouseleave", hideHandles);

    const updateSelection = () => {
      syncDragState();
      if (isReadonly()) { dom.style.outline = "none"; hideHandles(); return; }
      const pos = getPos();
      if (pos === undefined) return;
      const selected = editor.state.selection.from === pos;
      dom.style.outline = selected ? "2px solid var(--editor-color-accent, #0078d4)" : "none";
      dom.style.outlineOffset = "2px";
      dom.style.borderRadius = "var(--editor-radius, 4px)";
      if (selected) showHandles();
    };

    const selectImageNode = () => {
      const pos = getPos();
      if (pos !== undefined) editor.chain().focus().setNodeSelection(pos).run();
    };

    img.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      selectImageNode();
      if (isReadonly()) return;

      const startPos = getPos();
      if (startPos === undefined) return;

      const startX = e.clientX;
      const startY = e.clientY;
      let handed = false;

      const onMove = (ev: PointerEvent) => {
        if (handed) return;
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 6) return;

        handed = true;
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);

        startReorder(editor, startPos, currentNode.nodeSize, { ...currentNode.attrs }, img, ev);
      };

      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
    });

    img.addEventListener("click", () => {
      selectImageNode();
    });

    handles.forEach((handle) => {
      handle.addEventListener("mousedown", (e) => {
        if (isReadonly()) return;
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = img.offsetWidth;
        const aspectRatio = img.naturalHeight / img.naturalWidth || 1;
        const isLeft = handle.dataset.corner!.includes("w");

        const onMouseMove = (ev: MouseEvent) => {
          const dx = isLeft ? startX - ev.clientX : ev.clientX - startX;
          const newW = Math.max(MIN_WIDTH, startW + dx);
          img.style.width = `${newW}px`;
          img.style.height = `${Math.round(newW * aspectRatio)}px`;
        };

        const cleanup = () => {
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          activeDragCleanup = null;
        };

        const onMouseUp = (ev: MouseEvent) => {
          cleanup();
          const dx = isLeft ? startX - ev.clientX : ev.clientX - startX;
          const finalW = Math.max(MIN_WIDTH, startW + dx);
          const pos = getPos();
          if (pos !== undefined) {
            editor.chain()
              .setNodeSelection(pos)
              .updateAttributes("image", { width: finalW, height: Math.round(finalW * aspectRatio) })
              .run();
          }
        };

        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
        activeDragCleanup = cleanup;
      });
    });

    img.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = getPos();
      if (pos === undefined) return;
      const locale = (editor.storage.slashCommands?.locale ?? "en") as Locale;
      showContextMenu({ x: e.clientX, y: e.clientY }, editor, pos, currentSrc, locale);
    });

    editor.on("selectionUpdate", updateSelection);
    editor.on("transaction", syncDragState);
    syncDragState();

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== "image") return false;
        currentNode = updatedNode;
        currentSrc = updatedNode.attrs.src;
        img.src = updatedNode.attrs.src;
        if (updatedNode.attrs.alt) img.alt = updatedNode.attrs.alt;
        if (updatedNode.attrs.width) {
          img.style.width = `${updatedNode.attrs.width}px`;
          img.style.height = `${updatedNode.attrs.height}px`;
        }
        syncDragState();
        updateSelection();
        return true;
      },
      selectNode: () => {
        dom.style.outline = "2px solid var(--editor-color-accent, #0078d4)";
        dom.style.outlineOffset = "2px";
        showHandles();
      },
      deselectNode: () => { dom.style.outline = "none"; hideHandles(); },
      destroy: () => {
        editor.off("selectionUpdate", updateSelection);
        editor.off("transaction", syncDragState);
        activeDragCleanup?.();
      },
    };
  };
}
