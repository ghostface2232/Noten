import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";

const IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg"];

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  const chunkSize = 8192;
  const parts: string[] = [];

  for (let i = 0; i < bytes.length; i += chunkSize) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
  }

  return `data:${mimeType};base64,${btoa(parts.join(""))}`;
}

function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };

  return map[ext.toLowerCase()] ?? "image/png";
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
  editor.chain().focus().setImage({ src: dataUrl }).run();
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

            images.forEach(async (file) => {
              const reader = new FileReader();
              reader.onload = () => {
                const src = reader.result as string;
                if (pos) {
                  editor
                    .chain()
                    .focus()
                    .insertContentAt(pos.pos, {
                      type: "image",
                      attrs: { src },
                    })
                    .run();
                } else {
                  editor.chain().focus().setImage({ src }).run();
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
              reader.onload = () => {
                editor.chain().focus().setImage({ src: reader.result as string }).run();
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
