import { Extension, type Content, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection } from "@tiptap/pm/state";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  bytesToDataUrl,
  clampImageDimensions,
  mimeFromExt,
} from "../utils/imageUtils";
import {
  type DocumentImageContext,
  persistBinaryAsAsset,
  readImageBinary,
} from "../utils/imageAssetUtils";
import { extractMermaidSourceFromSvg } from "./mermaidSourceMetadata";

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

function getDocumentContext(editor: Editor): DocumentImageContext {
  const storageContext = editor.storage.documentContext;
  return {
    noteId: storageContext?.noteId ?? null,
    filePath: storageContext?.filePath ?? null,
  };
}

async function buildImageAttributesFromBinary(
  editor: Editor,
  bytes: Uint8Array,
  mime: string,
): Promise<{ src: string; width: number; height: number }> {
  const context = getDocumentContext(editor);
  const relativeSrc = await persistBinaryAsAsset({ bytes, mime }, context);
  const fallbackDataUrl = bytesToDataUrl(bytes, mime);
  const src = relativeSrc ?? fallbackDataUrl;
  const { width: natW, height: natH } = await loadImageSize(fallbackDataUrl);
  const { width, height } = clampImageDimensions(natW, natH, MAX_IMAGE_WIDTH);
  return { src, width, height };
}

export function isImagePath(path: string): boolean {
  const ext = path.split(".").pop();
  return ext ? IMAGE_EXTENSIONS.includes(ext.toLowerCase()) : false;
}

function isSvg(mime: string, fileName?: string): boolean {
  if (mime === "image/svg+xml") return true;
  const ext = fileName?.split(".").pop()?.toLowerCase();
  return ext === "svg";
}

/**
 * If `bytes` is an SVG we previously exported with an embedded Mermaid source,
 * return that source; otherwise null. Lets a round-tripped diagram come back as
 * editable text instead of a flat picture.
 */
function readEmbeddedMermaidSource(bytes: Uint8Array): string | null {
  return extractMermaidSourceFromSvg(new TextDecoder("utf-8").decode(bytes));
}

function mermaidCodeBlockContent(source: string): Content {
  return {
    type: "codeBlock",
    attrs: { language: "mermaid" },
    content: [{ type: "text", text: source }],
  };
}

/**
 * Build the editor node for an ingested file: a Mermaid code block when the
 * file is an SVG carrying our embedded source, otherwise an image node.
 */
async function buildNodeFromBinary(
  editor: Editor,
  bytes: Uint8Array,
  mime: string,
  fileName?: string,
): Promise<Content> {
  if (isSvg(mime, fileName)) {
    const source = readEmbeddedMermaidSource(bytes);
    if (source) return mermaidCodeBlockContent(source);
  }
  const { src, width, height } = await buildImageAttributesFromBinary(editor, bytes, mime);
  return { type: "image", attrs: { src, width, height } };
}

async function buildNodeFromPath(editor: Editor, path: string): Promise<Content> {
  const ext = path.split(".").pop() ?? "png";
  const mime = mimeFromExt(ext);
  const bytes = await readFile(path);
  return buildNodeFromBinary(editor, bytes, mime, path);
}

export async function buildImageContentFromPaths(editor: Editor, paths: string[]): Promise<Content[]> {
  return Promise.all(paths.map((path) => buildNodeFromPath(editor, path)));
}

export async function buildImageMarkdownFromPaths(editor: Editor, paths: string[]): Promise<string> {
  const blocks = await Promise.all(
    paths.map(async (path) => {
      const ext = path.split(".").pop() ?? "png";
      const mime = mimeFromExt(ext);
      const bytes = await readFile(path);
      if (isSvg(mime, path)) {
        const source = readEmbeddedMermaidSource(bytes);
        if (source) return `\`\`\`mermaid\n${source}\n\`\`\``;
      }
      const { src, width, height } = await buildImageAttributesFromBinary(editor, bytes, mime);
      return `<img src="${src}" alt="" width="${width}" height="${height}" />`;
    }),
  );
  return blocks.join("\n\n");
}

export async function insertImagesAtPosition(
  editor: Editor,
  paths: string[],
  pos?: number,
): Promise<void> {
  const content = await buildImageContentFromPaths(editor, paths);
  if (content.length === 0) return;

  const chain = editor.chain().focus();
  if (typeof pos === "number") {
    chain.setTextSelection(pos);
  }
  chain.insertContent(content).run();
}

export async function pickAndInsertImage(editor: Editor): Promise<void> {
  const selected = await open({
    filters: [{ name: "Images", extensions: IMAGE_EXTENSIONS }],
    multiple: false,
  });
  if (!selected) return;

  await insertImagesAtPosition(editor, [selected as string]);
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
          handleDOMEvents: {
            copy(view, event) {
              const { selection } = view.state;
              if (!(selection instanceof NodeSelection)) return false;
              const node = selection.node;
              if (node.type.name !== "image") return false;

              const src = node.attrs.src as string;
              event.preventDefault();
              void (async () => {
                try {
                  const payload = await readImageBinary(src, getDocumentContext(editor));
                  if (!payload) return;
                  const blob = new Blob([payload.bytes], { type: payload.mime });
                  await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
                } catch {
                  /* ignore */
                }
              })();
              return true;
            },
          },
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
              void (async () => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const mime = file.type || mimeFromExt(file.name.split(".").pop() ?? "png");
                const node = await buildNodeFromBinary(editor, bytes, mime, file.name);
                const chain = editor.chain().focus();
                if (pos) chain.setTextSelection(pos.pos);
                chain.insertContent(node).run();
              })();
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

              void (async () => {
                const bytes = new Uint8Array(await file.arrayBuffer());
                const mime = file.type || mimeFromExt(file.name.split(".").pop() ?? "png");
                const node = await buildNodeFromBinary(editor, bytes, mime, file.name);
                editor.chain().focus().insertContent(node).run();
              })();
            });

            return true;
          },
        },
      }),
    ];
  },
});

export default ImageDrop;
