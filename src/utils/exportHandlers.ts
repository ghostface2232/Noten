import { save, message } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";
import { readFile } from "@tauri-apps/plugin-fs";
import { assetPathForRenderedUrl } from "./imageAssetUtils";
import { mimeFromExt } from "./imageUtils";

async function fontToDataUrl(publicPath: string): Promise<string> {
  try {
    const resp = await fetch(publicPath);
    const buf = await resp.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return `data:font/woff2;base64,${btoa(binary)}`;
  } catch {
    return "";
  }
}

async function buildFontFaces(): Promise<string> {
  const fonts = [
    { family: "Pretendard JP", file: "/fonts/PretendardJP-Regular.woff2", weight: 400 },
    { family: "Pretendard JP", file: "/fonts/PretendardJP-Medium.woff2", weight: 500 },
    { family: "Pretendard JP", file: "/fonts/PretendardJP-SemiBold.woff2", weight: 600 },
    { family: "JetBrains Mono", file: "/fonts/JetBrainsMono-Regular.woff2", weight: 400 },
    { family: "JetBrains Mono", file: "/fonts/JetBrainsMono-Medium.woff2", weight: 500 },
  ];

  const faces: string[] = [];
  for (const f of fonts) {
    const dataUrl = await fontToDataUrl(f.file);
    if (dataUrl) {
      faces.push(`@font-face { font-family: "${f.family}"; src: url("${dataUrl}") format("woff2"); font-weight: ${f.weight}; font-style: normal; }`);
    }
  }
  return faces.join("\n");
}

const MD_FILTERS = [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }];
const PDF_FILTERS = [{ name: "PDF", extensions: ["pdf"] }];

// Transient editor decorations that live in the DOM but are not part of the
// document. Exporting `.ProseMirror`'s innerHTML verbatim baked them into the
// PDF — an open find bar printed every match in highlighter yellow.
const DECORATION_SELECTOR = ".search-match, .search-match-active";

/**
 * Copy of the editor DOM with decoration wrappers unwrapped, so the exported
 * markup carries only real document content. The live DOM is never touched.
 */
export function cloneEditorContentForExport(editorEl: HTMLElement): HTMLElement {
  const clone = editorEl.cloneNode(true) as HTMLElement;
  // Unwrap innermost-first: a match can nest inside another decoration span,
  // and replacing an outer node first would detach the inner ones unprocessed.
  const decorations = Array.from(clone.querySelectorAll<HTMLElement>(DECORATION_SELECTOR)).reverse();
  for (const node of decorations) {
    node.replaceWith(...Array.from(node.childNodes));
  }
  clone.normalize();
  return clone;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

const NOTE_ASSET_ORIGIN = "http://noten-asset.localhost/";

/**
 * Editor images load their asset through the app's noten-asset scheme, which
 * the headless browser that prints the PDF cannot reach. Inline them into the
 * export copy as data URLs, one at a time (reading every image at once holds
 * them all in memory together, which a note with hundreds of MB of images
 * cannot afford). Returns how many images could not be inlined and were
 * dropped; a noten-asset URL that does not map back to an `.assets` file is
 * dropped too rather than left for the renderer to request.
 */
export async function inlineAssetImages(root: HTMLElement): Promise<number> {
  let dropped = 0;
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>("img[src]"))) {
    const src = img.getAttribute("src")!;
    const path = assetPathForRenderedUrl(src);
    if (!path) {
      if (src.startsWith(NOTE_ASSET_ORIGIN)) {
        img.removeAttribute("src");
        dropped += 1;
      }
      continue;
    }
    try {
      const bytes = await readFile(path);
      const ext = path.slice(path.lastIndexOf(".") + 1);
      img.setAttribute("src", await blobToDataUrl(new Blob([bytes], { type: mimeFromExt(ext) })));
    } catch {
      img.removeAttribute("src");
      dropped += 1;
    }
  }
  return dropped;
}

export async function exportAsMarkdown(markdown: string, defaultName: string, locale: Locale = "en") {
  const selected = await save({
    title: t("dialog.export", locale),
    filters: MD_FILTERS,
    defaultPath: defaultName.replace(/\.[^.]+$/, "") + ".md",
  });
  if (!selected) return;
  try {
    await writeTextFile(selected, markdown);
  } catch (err) {
    await message(`${err}`, { title: t("dialog.exportFailed", locale), kind: "error" });
  }
}

export async function exportAsPdf(editorEl: HTMLElement, defaultName: string, locale: Locale = "en") {
  const selected = await save({
    title: t("dialog.export", locale),
    filters: PDF_FILTERS,
    defaultPath: defaultName.replace(/\.[^.]+$/, "") + ".pdf",
  });
  if (!selected) return;

  // Collect computed styles as inline text (avoids localhost URL references)
  const inlineStyles: string[] = [];
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        // Skip @font-face rules (we embed fonts separately with base64)
        if (rule instanceof CSSFontFaceRule) continue;
        inlineStyles.push(rule.cssText);
      }
    } catch {
      // Skip cross-origin sheets
    }
  }

  const fontFaces = await buildFontFaces();
  const exportRoot = cloneEditorContentForExport(editorEl);
  const droppedImages = await inlineAssetImages(exportRoot);

  const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${fontFaces}</style>
<style>${inlineStyles.join("\n")}</style>
<style>
  html, body {
    margin: 0; padding: 0;
    background: #fff !important; color: #000 !important;
  }
  .ProseMirror {
    padding: 40px 60px !important;
    min-height: auto !important;
    max-width: 100% !important;
    color: #000 !important;
    background: #fff !important;
    font-size: 11pt !important;
    line-height: 1.7 !important;
  }
  .ProseMirror * { color: inherit !important; }
  /* The editor's off-screen containment (tiptap-editor.css) must not decide
     how blocks break across pages. */
  .ProseMirror > * { contain: none !important; content-visibility: visible !important; }
  /* Print wide tables whole rather than inside the editor's scrolling wrapper. */
  .ProseMirror > .tableWrapper { overflow: visible !important; }
  .ProseMirror h1 { font-size: 22pt !important; font-weight: 600; }
  .ProseMirror h2 { font-size: 18pt !important; font-weight: 500; }
  .ProseMirror h3 { font-size: 14pt !important; font-weight: 500; }
  .ProseMirror pre {
    position: relative !important;
    background-color: #f6f6f6 !important;
    padding: 0 !important;
    border-radius: 8px !important;
    overflow: hidden !important;
    border: none !important;
    font-family: "JetBrains Mono", "Pretendard JP", Consolas, "Courier New", monospace !important;
    font-size: 0.9em !important;
    line-height: 1.5 !important;
    color: #333 !important;
  }
  .ProseMirror pre::before {
    content: attr(data-language) !important;
    display: block !important;
    padding: 0.4rem 1rem !important;
    background-color: #e0e0e0 !important;
    font-family: "Pretendard JP", system-ui, sans-serif !important;
    font-size: 0.75em !important;
    color: #616161 !important;
    text-transform: uppercase !important;
    letter-spacing: 0.05em !important;
  }
  .ProseMirror pre code {
    display: block !important;
    padding: 1rem !important;
    background: none !important;
    border-radius: 0 !important;
    font-size: inherit !important;
    color: inherit !important;
    overflow-x: auto !important;
    white-space: pre-wrap !important;
    word-break: break-all !important;
  }
  .ProseMirror pre * { color: inherit !important; }
  /* hljs syntax colors */
  .ProseMirror pre .hljs-comment,
  .ProseMirror pre .hljs-quote { color: #616161 !important; font-style: italic !important; }
  .ProseMirror pre .hljs-keyword,
  .ProseMirror pre .hljs-selector-tag,
  .ProseMirror pre .hljs-built_in { color: #0078d4 !important; }
  .ProseMirror pre .hljs-string,
  .ProseMirror pre .hljs-attr { color: #0a7e07 !important; }
  .ProseMirror pre .hljs-number,
  .ProseMirror pre .hljs-literal { color: #9c5d27 !important; }
  .ProseMirror pre .hljs-title,
  .ProseMirror pre .hljs-section { font-weight: 500 !important; }
  .ProseMirror code {
    color: #333 !important;
    background-color: #f6f6f6 !important;
    font-family: "JetBrains Mono", "Pretendard JP", Consolas, "Courier New", monospace !important;
    font-size: 0.9em !important;
    padding: 0.15em 0.4em !important;
    border-radius: 4px !important;
  }
  .ProseMirror img { max-width: 100% !important; }
  .ProseMirror blockquote {
    border-left: 3px solid #ccc !important;
    padding-left: 12pt !important;
    color: #555 !important;
  }
  .ProseMirror ul, .ProseMirror ol {
    padding-left: 1.5em !important;
  }
  .ProseMirror table {
    border-collapse: collapse !important;
    width: 100% !important;
  }
  .ProseMirror th, .ProseMirror td {
    border: 1px solid #ccc !important;
    padding: 6px 10px !important;
  }
  .ProseMirror th {
    background: #f5f5f5 !important;
    font-weight: 600 !important;
  }
</style>
</head><body>
  <div class="ProseMirror">${exportRoot.innerHTML}</div>
</body></html>`;

  try {
    await invoke("print_to_pdf", { html: htmlContent, outputPath: selected });
    if (droppedImages > 0) {
      await message(t("dialog.exportImagesMissing", locale).replace("{n}", String(droppedImages)), {
        title: t("dialog.export", locale),
        kind: "warning",
      });
    }
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error("PDF export failed:", err);
    }
    await message(`PDF export failed: ${err}`, { title: t("dialog.exportFailed", locale), kind: "error" });
  }
}

