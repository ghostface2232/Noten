import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { bytesToDataUrl, mimeFromExt } from "../utils/imageUtils";

const IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];
const MAX_IMAGE_WIDTH = 560;

function loadImageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({ width: 0, height: 0 });
    img.src = src;
  });
}

export async function pickAndInsertImage(editor: Editor): Promise<void> {
  const selected = await open({
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    multiple: false,
  });
  if (!selected) return;

  const path = selected as string;
  const ext = path.split(".").pop() ?? "png";
  const bytes = await readFile(path);
  const dataUrl = bytesToDataUrl(bytes, mimeFromExt(ext));
  const { width: natW, height: natH } = await loadImageSize(dataUrl);
  const w = natW > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH : natW;
  const h = natW > MAX_IMAGE_WIDTH ? Math.round(natH * (MAX_IMAGE_WIDTH / natW)) : natH;
  editor.chain().focus().setImage({ src: dataUrl, width: w, height: h }).run();
}

const ImageDrop = Extension.create({
  name: "imageDrop",
  priority: 101,

  addProseMirrorPlugins() {
    const editor = this.editor;

    return [
      new Plugin({
        key: new PluginKey("imageDrop"),
        props: {
          handleDrop(view, event) {
            const files = event.dataTransfer?.files;
            if (!files || files.length === 0) return false;

            const images = Array.from(files).filter((file) => IMAGE_MIME.includes(file.type));
            if (images.length === 0) return false;

            event.preventDefault();

            const pos = view.posAtCoords({
              left: event.clientX,
              top: event.clientY,
            });

            images.forEach((file) => {
              const reader = new FileReader();
              reader.onload = async () => {
                const src = reader.result as string;
                const { width: natW, height: natH } = await loadImageSize(src);
                const w = natW > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH : natW;
                const h = natW > MAX_IMAGE_WIDTH ? Math.round(natH * (MAX_IMAGE_WIDTH / natW)) : natH;
                if (pos) {
                  editor
                    .chain()
                    .focus()
                    .insertContentAt(pos.pos, {
                      type: "image",
                      attrs: { src, width: w, height: h },
                    })
                    .run();
                } else {
                  editor.chain().focus().setImage({ src, width: w, height: h }).run();
                }
              };
              reader.readAsDataURL(file);
            });

            return true;
          },

          handlePaste(_view, event) {
            const items = event.clipboardData?.items;
            if (!items) return false;

            const imageItems = Array.from(items).filter(
              (item) => item.kind === "file" && IMAGE_MIME.includes(item.type),
            );
            if (imageItems.length === 0) return false;

            event.preventDefault();

            imageItems.forEach((item) => {
              const file = item.getAsFile();
              if (!file) return;

              const reader = new FileReader();
              reader.onload = async () => {
                const src = reader.result as string;
                const { width: natW, height: natH } = await loadImageSize(src);
                const w = natW > MAX_IMAGE_WIDTH ? MAX_IMAGE_WIDTH : natW;
                const h = natW > MAX_IMAGE_WIDTH ? Math.round(natH * (MAX_IMAGE_WIDTH / natW)) : natH;
                editor.chain().focus().setImage({ src, width: w, height: h }).run();
              };
              reader.readAsDataURL(file);
            });

            return true;
          },
        },
      }),
    ];
  },
});

export default ImageDrop;
