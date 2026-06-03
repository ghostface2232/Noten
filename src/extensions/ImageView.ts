import { type Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { startReorder } from "./ImageReorder";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { bytesToDataUrl, mimeFromExt } from "../utils/imageUtils";
import {
  type DocumentImageContext,
  persistBinaryAsAsset,
  readImageBinary,
  resolveRenderableImageSource,
} from "../utils/imageAssetUtils";
import { closeContextMenu, createMenuShell, createMenuItem } from "../utils/contextMenuRegistry";

const HANDLE_SIZE = 10;
const HANDLE_HIT = 32;
const MIN_WIDTH = 60;

// All image NodeViews of one editor share a single `transaction` subscription
// instead of each registering its own. With N images, a per-NodeView listener
// re-ran updateSelection N times on every keystroke even though only a
// selection or readonly change can alter an image's outline. The shared handler
// recomputes a tiny signature (node-selected position + readonly flag) and only
// re-syncs the registered NodeViews when it actually changes — so plain typing,
// which keeps a TextSelection, costs O(1) instead of O(images). The brute-force
// "re-sync every image on any selection change" behaviour is preserved, which is
// what covers PM's unreliable selectNode/deselectNode bookkeeping.
interface ImageSelectionSync {
  controllers: Set<() => void>;
  handler: () => void;
  lastSignature: string;
}

const imageSelectionSyncByEditor = new WeakMap<Editor, ImageSelectionSync>();

function selectionSignature(editor: Editor): string {
  const readonly = editor.storage.readonlyGuard?.readonly ? "1" : "0";
  const { selection } = editor.state;
  const nodePos = selection instanceof NodeSelection ? selection.from : -1;
  return `${readonly}:${nodePos}`;
}

function registerImageSelectionSync(editor: Editor, updateSelection: () => void): () => void {
  let sync = imageSelectionSyncByEditor.get(editor);
  if (!sync) {
    const state: ImageSelectionSync = {
      controllers: new Set(),
      lastSignature: selectionSignature(editor),
      handler: () => {},
    };
    state.handler = () => {
      const next = selectionSignature(editor);
      if (next === state.lastSignature) return;
      state.lastSignature = next;
      state.controllers.forEach((fn) => fn());
    };
    editor.on("transaction", state.handler);
    imageSelectionSyncByEditor.set(editor, state);
    sync = state;
  }
  sync.controllers.add(updateSelection);
  return () => {
    const current = imageSelectionSyncByEditor.get(editor);
    if (!current) return;
    current.controllers.delete(updateSelection);
    if (current.controllers.size === 0) {
      editor.off("transaction", current.handler);
      imageSelectionSyncByEditor.delete(editor);
    }
  };
}

function showContextMenu(
  pos: { x: number; y: number },
  editor: Editor,
  nodePos: number,
  src: string,
  context: DocumentImageContext,
  locale: Locale,
) {
  const i = (key: Parameters<typeof t>[0]) => t(key, locale);
  const { menu, isDark } = createMenuShell(pos, 160);

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
        const payload = await readImageBinary(src, context);
        if (!payload) return;
        const ext = payload.mime === "image/jpeg"
          ? "jpg"
          : payload.mime === "image/png"
            ? "png"
            : payload.mime === "image/gif"
              ? "gif"
              : payload.mime === "image/webp"
                ? "webp"
                : payload.mime === "image/svg+xml"
                  ? "svg"
                  : "png";
        const path = await save({ title: i("dialog.saveImage"), filters: [{ name: "Image", extensions: [ext] }] });
        if (!path) return;
        await writeFile(path, payload.bytes);
      },
    },
    {
      label: i("image.copy"), icon: iconCopy,
      action: async () => {
        closeContextMenu();
        try {
          const payload = await readImageBinary(src, context);
          if (!payload) return;
          const blob = new Blob([payload.bytes], { type: payload.mime });
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
        const mime = mimeFromExt(ext);
        const relativeSrc = await persistBinaryAsAsset({ bytes: fileBytes, mime }, context);
        const fallbackDataUrl = bytesToDataUrl(fileBytes, mime);
        editor.chain().focus().setNodeSelection(nodePos).updateAttributes("image", { src: relativeSrc ?? fallbackDataUrl }).run();
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
    const btn = createMenuItem(item.label, null, { danger: item.danger, icon: item.icon, isDark });
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
    dom.className = "tiptap-image-node";
    // border-radius / outline-offset are set up-front so a session-restored
    // NodeSelection (which only triggers selectNode, not selectionUpdate) still
    // paints a rounded outline.
    dom.style.cssText = "position:relative;display:inline-block;max-width:100%;line-height:0;border-radius:var(--editor-radius, 4px);outline-offset:2px;";
    dom.draggable = false;

    const img = document.createElement("img");
    const getContext = (): DocumentImageContext => ({
      noteId: editor.storage.documentContext?.noteId ?? null,
      filePath: editor.storage.documentContext?.filePath ?? null,
    });

    let imageSourceToken = 0;
    const syncImageSource = (source: string) => {
      const token = ++imageSourceToken;
      void (async () => {
        const resolved = await resolveRenderableImageSource(source, getContext());
        if (token !== imageSourceToken) return;
        if (resolved) {
          img.src = resolved;
        } else {
          img.removeAttribute("src");
        }
      })();
    };

    syncImageSource(HTMLAttributes.src);
    if (HTMLAttributes.alt) img.alt = HTMLAttributes.alt;
    if (HTMLAttributes.title) img.title = HTMLAttributes.title;
    img.draggable = false;
    img.style.cssText = "display:block;max-width:100%;height:auto;border-radius:var(--editor-radius);cursor:default;";
    if (HTMLAttributes.width) img.style.width = `${HTMLAttributes.width}px`;
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
      if (corner.includes("n")) hitArea.style.top = `-${HANDLE_SIZE / 2}px`;
      if (corner.includes("s")) hitArea.style.bottom = `-${HANDLE_SIZE / 2}px`;
      if (corner.includes("w")) hitArea.style.left = `-${HANDLE_SIZE / 2}px`;
      if (corner.includes("e")) hitArea.style.right = `-${HANDLE_SIZE / 2}px`;
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
      const { selection } = editor.state;
      const selected = pos !== undefined
        && selection instanceof NodeSelection
        && selection.from === pos;
      dom.style.outline = selected ? "2px solid var(--editor-color-accent, #0078d4)" : "none";
      if (selected) showHandles();
    };

    const selectImageNode = () => {
      const pos = getPos();
      if (pos === undefined) return;
      const view = editor.view;
      if (!view) return;
      // Ensure view.dom owns native focus before changing selection. When the editor
      // had been blurred (e.g. user clicked sidebar/titlebar to deselect), Tiptap's
      // chain().focus() defers focus via requestAnimationFrame, which can race with
      // the subsequent setNodeSelection and leave PM's selection-sync bookkeeping in
      // a state where selectNode() is never re-run on the same NodeView. Focusing
      // synchronously and dispatching the NodeSelection directly avoids that race.
      if (!view.hasFocus()) view.focus();
      view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
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
      showContextMenu({ x: e.clientX, y: e.clientY }, editor, pos, currentSrc, getContext(), locale);
    });

    // Selection re-sync is driven by a single shared transaction subscription
    // (see registerImageSelectionSync) rather than a per-image listener. Run once
    // now so a session-restored NodeSelection paints its outline immediately.
    const unregisterSelectionSync = registerImageSelectionSync(editor, updateSelection);
    updateSelection();

    return {
      dom,
      update: (updatedNode: any) => {
        if (updatedNode.type.name !== "image") return false;
        currentNode = updatedNode;
        currentSrc = updatedNode.attrs.src;
        syncImageSource(updatedNode.attrs.src);
        if (updatedNode.attrs.alt) img.alt = updatedNode.attrs.alt;
        if (updatedNode.attrs.width) {
          img.style.width = `${updatedNode.attrs.width}px`;
        }
        syncDragState();
        updateSelection();
        return true;
      },
      selectNode: () => {
        dom.style.outline = "2px solid var(--editor-color-accent, #0078d4)";
        showHandles();
      },
      deselectNode: () => { dom.style.outline = "none"; hideHandles(); },
      destroy: () => {
        imageSourceToken += 1;
        unregisterSelectionSync();
        activeDragCleanup?.();
      },
    };
  };
}
