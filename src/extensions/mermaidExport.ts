/**
 * Mermaid diagram export utilities.
 *
 * Exports the rendered Mermaid <svg> to SVG or PNG with:
 *   - CSS variables resolved to concrete computed values (so the file
 *     renders identically outside the app where --editor-color-* are undefined)
 *   - viewBox tightened to the diagram's bounding box (no extra padding)
 *   - transparent background
 *
 * Save is handled through Tauri's native "Save As" dialog so the user picks
 * the target path themselves. Functions return `true` on a completed write,
 * `false` if the user cancelled the dialog.
 */

import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { t } from "../i18n";
import type { Locale } from "../hooks/useSettings";

// Visual CSS properties that need to be inlined onto every node so the
// exported SVG is self-contained. We deliberately avoid layout-affecting
// properties (width/height/transform) — those come from SVG attributes.
const INLINED_STYLE_PROPS = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "letter-spacing",
  "filter",
] as const;

// HTML elements appearing inside <foreignObject> also need style inlining for
// text (mermaid uses <div>/<span>/<p> inside foreignObject for HTML labels in
// some diagram types).
const INLINED_HTML_STYLE_PROPS = [
  "color",
  "background",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-align",
  "line-height",
  "padding",
  "margin",
  "border",
  "border-radius",
] as const;

const EXPORT_BBOX_PADDING_PX = 4;
const PNG_BASE_SCALE = 2;
const PNG_HIDPI_SCALE = 4;
const PNG_HIDPI_TRIGGER_WIDTH_PX = 1000;

/**
 * Inline computed styles from `src` (live in DOM) onto `dst` (clone).
 * Both trees must have identical structure since we traverse in parallel.
 */
function inlineComputedStyles(src: Element, dst: Element) {
  const isHtml = !(src instanceof SVGElement);
  const computed = window.getComputedStyle(src);
  const propList = isHtml ? INLINED_HTML_STYLE_PROPS : INLINED_STYLE_PROPS;

  for (const prop of propList) {
    const value = computed.getPropertyValue(prop);
    if (!value) continue;
    // Skip default-ish values that just bloat the file.
    if (value === "none" && (prop === "filter" || prop === "stroke-dasharray")) continue;
    (dst as HTMLElement | SVGElement).style.setProperty(prop, value);
  }

  const srcChildren = src.children;
  const dstChildren = dst.children;
  const count = Math.min(srcChildren.length, dstChildren.length);
  for (let i = 0; i < count; i += 1) {
    inlineComputedStyles(srcChildren[i], dstChildren[i]);
  }
}

/**
 * Read the diagram's true bounding box from the live SVG, then apply it to
 * the clone's viewBox so the exported image has no surrounding whitespace.
 *
 * We read from the live element because getBBox() requires the node to be in
 * a rendered tree. The clone hasn't been mounted yet.
 */
function tightenViewBox(liveSvg: SVGSVGElement, cloneSvg: SVGSVGElement) {
  let bbox: { x: number; y: number; width: number; height: number };
  try {
    const raw = liveSvg.getBBox();
    bbox = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
  } catch {
    return; // leave the original viewBox alone if getBBox fails
  }

  if (!Number.isFinite(bbox.width) || !Number.isFinite(bbox.height) || bbox.width <= 0 || bbox.height <= 0) {
    return;
  }

  const pad = EXPORT_BBOX_PADDING_PX;
  const x = bbox.x - pad;
  const y = bbox.y - pad;
  const width = bbox.width + pad * 2;
  const height = bbox.height + pad * 2;

  cloneSvg.setAttribute("viewBox", `${x} ${y} ${width} ${height}`);
  cloneSvg.setAttribute("width", width.toFixed(2));
  cloneSvg.setAttribute("height", height.toFixed(2));
  // Drop any preserveAspectRatio overrides that might letterbox the image.
  cloneSvg.removeAttribute("preserveAspectRatio");
}

/**
 * Build a self-contained, exportable SVG element from the live rendered one.
 * Caller should serialize/blob it; this function does not touch the DOM
 * outside of cloning.
 */
function buildExportSvg(liveSvg: SVGSVGElement): SVGSVGElement {
  const clone = liveSvg.cloneNode(true) as SVGSVGElement;

  // Required for standalone serialization.
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  // Transparent background: remove any inherited background style.
  clone.style.background = "transparent";
  clone.style.backgroundColor = "transparent";

  inlineComputedStyles(liveSvg, clone);
  tightenViewBox(liveSvg, clone);

  return clone;
}

function serializeSvg(svg: SVGSVGElement): string {
  const xml = new XMLSerializer().serializeToString(svg);
  // Prepend the XML declaration so external tools (Inkscape, Illustrator) are happy.
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n${xml}`;
}

/**
 * Show a native Save As dialog and write the bytes. Returns the chosen path
 * on success, or `null` if the user cancelled.
 */
async function saveAs(
  bytes: Uint8Array,
  defaultFileName: string,
  format: "svg" | "png",
  locale: Locale,
): Promise<string | null> {
  const filter =
    format === "svg"
      ? { name: "SVG image", extensions: ["svg"] }
      : { name: "PNG image", extensions: ["png"] };

  const path = await save({
    title: t(format === "svg" ? "mermaid.exportSvgDialog" : "mermaid.exportPngDialog", locale),
    defaultPath: defaultFileName,
    filters: [filter],
  });

  if (!path) {
    return null;
  }

  await writeFile(path, bytes);
  return path;
}

export async function exportMermaidSvg(liveSvg: SVGSVGElement, fileName: string, locale: Locale): Promise<boolean> {
  const exportSvg = buildExportSvg(liveSvg);
  const serialized = serializeSvg(exportSvg);
  const bytes = new TextEncoder().encode(serialized);
  const result = await saveAs(bytes, fileName, "svg", locale);
  return result !== null;
}

/**
 * Convert the export SVG to PNG via canvas. The canvas is never filled, so
 * the output PNG has a transparent background (alpha channel preserved).
 *
 * Scale rule: base 2× pixels. If 2× width would still be ≤ 1000px, bump to 4×
 * so small diagrams stay crisp when scaled up in slides/docs.
 */
export async function exportMermaidPng(liveSvg: SVGSVGElement, fileName: string, locale: Locale): Promise<boolean> {
  const exportSvg = buildExportSvg(liveSvg);
  const widthAttr = parseFloat(exportSvg.getAttribute("width") ?? "0");
  const heightAttr = parseFloat(exportSvg.getAttribute("height") ?? "0");
  if (!widthAttr || !heightAttr) {
    throw new Error("Mermaid diagram has no measurable size");
  }

  const scale = widthAttr * PNG_BASE_SCALE <= PNG_HIDPI_TRIGGER_WIDTH_PX ? PNG_HIDPI_SCALE : PNG_BASE_SCALE;
  const pixelWidth = Math.max(1, Math.round(widthAttr * scale));
  const pixelHeight = Math.max(1, Math.round(heightAttr * scale));

  const serialized = serializeSvg(exportSvg);
  // Use a data URL rather than a blob URL: Tauri's webview sometimes refuses
  // to load `blob:tauri://localhost/...` into an <img>, which silently fires
  // onerror before we ever get to open the Save As dialog.
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;

  let pngBytes: Uint8Array;
  try {
    const image = await loadImage(svgDataUrl);

    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to acquire 2D canvas context");
    }
    // Leave canvas transparent — drawImage onto a fresh canvas keeps alpha.
    ctx.drawImage(image, 0, 0, pixelWidth, pixelHeight);

    let pngBlob: Blob | null;
    try {
      pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    } catch (err) {
      // toBlob throws SecurityError on a tainted canvas (e.g. external font
      // referenced from inside a foreignObject). Re-throw with a helpful hint.
      throw new Error(
        `Canvas is tainted and cannot be exported as PNG. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!pngBlob) {
      throw new Error("Failed to encode PNG (canvas.toBlob returned null)");
    }
    pngBytes = new Uint8Array(await pngBlob.arrayBuffer());
  } catch (err) {
    // Log to the console too — the in-app error element is small and easy to
    // miss, and PNG conversion failures are usually environment-specific.
    console.error("[mermaid-export] PNG conversion failed:", err);
    throw err;
  }

  const result = await saveAs(pngBytes, fileName, "png", locale);
  return result !== null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      // Some webviews resolve `onload` before the image is actually decoded.
      // If width is 0 we know decoding failed silently.
      if (image.naturalWidth === 0 || image.naturalHeight === 0) {
        reject(new Error("SVG loaded but has zero size — decoding likely failed"));
        return;
      }
      resolve(image);
    };
    image.onerror = (event) => {
      const detail = typeof event === "string" ? event : (event as ErrorEvent)?.message;
      reject(new Error(`Failed to load SVG into image element${detail ? `: ${detail}` : ""}`));
    };
    image.src = src;
  });
}

export function buildExportFileName(extension: "svg" | "png"): string {
  const now = new Date();
  const pad = (value: number) => value.toString().padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `mermaid-diagram-${stamp}.${extension}`;
}
