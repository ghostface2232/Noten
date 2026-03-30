import { type Editor } from "@tiptap/core";
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

  const items: { label: string; danger?: boolean; action: () => void }[] = [
    {
      label: i("image.save"),
      action: async () => {
        closeContextMenu();
        const ext = mimeToExt(src);
        const path = await save({ filters: [{ name: "Image", extensions: [ext] }] });
        if (!path) return;
        await writeFile(path, dataUrlToUint8Array(src));
      },
    },
    {
      label: i("image.copy"),
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
      label: i("image.replace"),
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
      label: i("image.delete"),
      danger: true,
      action: () => {
        closeContextMenu();
        editor.chain().focus().setNodeSelection(nodePos).deleteSelection().run();
      },
    },
  ];

  items.forEach((item) => {
    const btn = createMenuItem(item.label, null, { danger: item.danger });
    btn.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); item.action(); });
    menu.appendChild(btn);
  });
}

export function createImageNodeView(editor: Editor) {
  return (props: { node: any; getPos: () => number | undefined; HTMLAttributes: Record<string, any> }) => {
    const { node, getPos, HTMLAttributes } = props;

    let currentSrc = node.attrs.src;
    let activeDragCleanup: (() => void) | null = null;

    const dom = document.createElement("div");
    dom.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0;";

    const img = document.createElement("img");
    img.src = HTMLAttributes.src;
    if (HTMLAttributes.alt) img.alt = HTMLAttributes.alt;
    if (HTMLAttributes.title) img.title = HTMLAttributes.title;
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

    const showHandles = () => {
      if (isReadonly()) return;
      handles.forEach((h) => { h.style.opacity = "1"; h.style.pointerEvents = "auto"; });
    };
    const hideHandles = () => handles.forEach((h) => { h.style.opacity = "0"; h.style.pointerEvents = "none"; });
    dom.addEventListener("mouseenter", showHandles);
    dom.addEventListener("mouseleave", hideHandles);

    const updateSelection = () => {
      if (isReadonly()) { dom.style.outline = "none"; hideHandles(); return; }
      const pos = getPos();
      if (pos === undefined) return;
      const selected = editor.state.selection.from === pos;
      dom.style.outline = selected ? "2px solid var(--editor-color-accent, #0078d4)" : "none";
      dom.style.outlineOffset = "2px";
      dom.style.borderRadius = "var(--editor-radius, 4px)";
      if (selected) showHandles();
    };

    img.addEventListener("click", () => {
      if (isReadonly()) return;
      const pos = getPos();
      if (pos !== undefined) editor.commands.setNodeSelection(pos);
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

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== "image") return false;
        currentSrc = updatedNode.attrs.src;
        img.src = updatedNode.attrs.src;
        if (updatedNode.attrs.alt) img.alt = updatedNode.attrs.alt;
        if (updatedNode.attrs.width) {
          img.style.width = `${updatedNode.attrs.width}px`;
          img.style.height = `${updatedNode.attrs.height}px`;
        }
        updateSelection();
        return true;
      },
      selectNode: () => {
        dom.style.outline = "2px solid var(--editor-color-accent, #0078d4)";
        dom.style.outlineOffset = "2px";
        showHandles();
      },
      deselectNode: () => { dom.style.outline = "none"; hideHandles(); },
      destroy: () => { editor.off("selectionUpdate", updateSelection); activeDragCleanup?.(); },
    };
  };
}
