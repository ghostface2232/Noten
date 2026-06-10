import { mkdir, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { dataUrlToUint8Array, mimeToExt } from "./imageUtils";
import { buildAssetRelativePath, getNoteIdFromFilePath, resolveAssetAbsolutePath } from "./imageAssetUtils";

const HTML_IMG_DATA_URL_RE = /<img\b[^>]*\bsrc=(["'])(data:image\/[a-zA-Z0-9.+-]+;base64,[^"']+)\1[^>]*>/gi;
const MARKDOWN_IMG_DATA_URL_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[^)\s]+)(?:\s+"([^"]*)")?\)/g;

interface ReplaceMatch {
  start: number;
  end: number;
  replacement: string;
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : normalized;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

async function buildAssetSource(
  dataUrl: string,
  noteId: string,
  noteFilePath: string,
  cache: Map<string, string>,
): Promise<string> {
  // The cache key MUST include the noteId. Asset paths are per-note
  // (.assets/<noteId>/<hash>.ext), so a dataUrl-only key would make a second
  // note containing the same image reuse the FIRST note's asset path — its
  // markdown then points into another note's asset dir and its own asset file
  // is never written. Deleting the first note later (removeNoteAssetDir)
  // permanently breaks the second note's image.
  const cacheKey = `${noteId}\n${dataUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const bytes = dataUrlToUint8Array(dataUrl);
  const hash = await sha256Hex(bytes);
  const ext = mimeToExt(dataUrl);
  const relativePath = buildAssetRelativePath(noteId, `${hash}.${ext}`);
  const absolutePath = resolveAssetAbsolutePath(relativePath, noteFilePath);
  if (!absolutePath) return dataUrl;

  await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
  await writeFile(absolutePath, bytes);
  cache.set(cacheKey, relativePath);
  return relativePath;
}

function applyReplacements(input: string, replacements: ReplaceMatch[]): string {
  if (replacements.length === 0) return input;
  const sorted = [...replacements].sort((a, b) => a.start - b.start);
  let cursor = 0;
  let output = "";

  for (const match of sorted) {
    output += input.slice(cursor, match.start);
    output += match.replacement;
    cursor = match.end;
  }

  output += input.slice(cursor);
  return output;
}

async function replaceHtmlImageDataUrls(
  markdown: string,
  noteId: string,
  noteFilePath: string,
  cache: Map<string, string>,
): Promise<{ markdown: string; converted: number }> {
  HTML_IMG_DATA_URL_RE.lastIndex = 0;
  const replacements: ReplaceMatch[] = [];
  let converted = 0;

  for (const match of markdown.matchAll(HTML_IMG_DATA_URL_RE)) {
    const full = match[0];
    const dataUrl = match[2];
    const start = match.index ?? -1;
    if (start < 0 || !dataUrl) continue;
    const end = start + full.length;
    const src = await buildAssetSource(dataUrl, noteId, noteFilePath, cache);
    if (src === dataUrl) continue;
    const replacement = full.replace(dataUrl, src);
    replacements.push({ start, end, replacement });
    converted += 1;
  }

  return { markdown: applyReplacements(markdown, replacements), converted };
}

async function replaceMarkdownImageDataUrls(
  markdown: string,
  noteId: string,
  noteFilePath: string,
  cache: Map<string, string>,
): Promise<{ markdown: string; converted: number }> {
  MARKDOWN_IMG_DATA_URL_RE.lastIndex = 0;
  const replacements: ReplaceMatch[] = [];
  let converted = 0;

  for (const match of markdown.matchAll(MARKDOWN_IMG_DATA_URL_RE)) {
    const full = match[0];
    const alt = match[1] ?? "";
    const dataUrl = match[2];
    const title = match[3];
    const start = match.index ?? -1;
    if (start < 0 || !dataUrl) continue;
    const end = start + full.length;
    const src = await buildAssetSource(dataUrl, noteId, noteFilePath, cache);
    if (src === dataUrl) continue;
    const replacement = title
      ? `![${alt}](${src} "${title}")`
      : `![${alt}](${src})`;
    replacements.push({ start, end, replacement });
    converted += 1;
  }

  return { markdown: applyReplacements(markdown, replacements), converted };
}

export interface ImageAssetMigrationResult {
  changedFiles: number;
  convertedImages: number;
}

export async function migrateDataUrlImagesToAssets(noteFilePaths: string[]): Promise<ImageAssetMigrationResult> {
  let changedFiles = 0;
  let convertedImages = 0;
  const cache = new Map<string, string>();

  for (const path of noteFilePaths) {
    const noteId = getNoteIdFromFilePath(path);
    if (!noteId) continue;

    let raw = "";
    try {
      raw = await readTextFile(path);
    } catch {
      continue;
    }

    if (!raw.includes("data:image/")) continue;

    const htmlPass = await replaceHtmlImageDataUrls(raw, noteId, path, cache);
    const markdownPass = await replaceMarkdownImageDataUrls(htmlPass.markdown, noteId, path, cache);
    const next = markdownPass.markdown;
    const converted = htmlPass.converted + markdownPass.converted;
    if (converted === 0 || next === raw) continue;

    await writeTextFile(path, next);
    changedFiles += 1;
    convertedImages += converted;
  }

  return { changedFiles, convertedImages };
}
