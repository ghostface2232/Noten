import { mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { bytesToDataUrl, dataUrlToUint8Array, mimeFromDataUrl, mimeFromExt, mimeToExt } from "./imageUtils";

export interface DocumentImageContext {
  noteId: string | null;
  filePath: string | null;
}

export interface ImageBinaryPayload {
  bytes: Uint8Array;
  mime: string;
}

function toUnixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function dirname(path: string): string {
  const normalized = toUnixPath(path);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : normalized;
}

function extFromPath(path: string): string {
  const normalized = toUnixPath(path);
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = file.lastIndexOf(".");
  return dot >= 0 ? file.slice(dot + 1).toLowerCase() : "png";
}

function extFromMime(mime: string): string {
  const normalized = mime.toLowerCase();
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/png") return "png";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/svg+xml") return "svg";
  return "png";
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

function stripLeadingCurrentDir(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}

export function isDataImageSource(src: string): boolean {
  return src.startsWith("data:image/");
}

export function isRelativeAssetSource(src: string): boolean {
  const normalized = stripLeadingCurrentDir(src.trim());
  return normalized.startsWith(".assets/");
}

export function getNoteIdFromFilePath(filePath: string | null): string | null {
  if (!filePath) return null;
  const normalized = toUnixPath(filePath);
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!file.toLowerCase().endsWith(".md")) return null;
  return file.slice(0, -3) || null;
}

export function buildAssetRelativePath(noteId: string, filename: string): string {
  return `.assets/${noteId}/${filename}`;
}

export async function removeNoteAssetDir(notesDir: string, noteId: string): Promise<void> {
  if (!notesDir || !noteId) return;
  const sep = notesDir.endsWith("/") || notesDir.endsWith("\\") ? "" : "/";
  const dir = `${notesDir}${sep}.assets/${noteId}`;
  try {
    await remove(dir, { recursive: true });
  } catch {
    // Directory may not exist (note had no images) — ignore
  }
}

export function resolveAssetAbsolutePath(src: string, noteFilePath: string | null): string | null {
  if (!noteFilePath || !isRelativeAssetSource(src)) return null;
  const normalizedSrc = stripLeadingCurrentDir(src.trim());
  return `${dirname(noteFilePath)}/${normalizedSrc}`;
}

const renderableSourceCache = new Map<string, string>();

export async function persistDataUrlAsAsset(
  dataUrl: string,
  context: DocumentImageContext,
): Promise<string> {
  if (!context.noteId || !context.filePath || !isDataImageSource(dataUrl)) {
    return dataUrl;
  }

  const bytes = dataUrlToUint8Array(dataUrl);
  const hash = await sha256Hex(bytes);
  const ext = mimeToExt(dataUrl);
  const filename = `${hash}.${ext}`;
  const relativePath = buildAssetRelativePath(context.noteId, filename);
  const absolutePath = resolveAssetAbsolutePath(relativePath, context.filePath);
  if (!absolutePath) return dataUrl;

  await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
  await writeFile(absolutePath, bytes);
  return relativePath;
}

export async function persistBinaryAsAsset(
  payload: ImageBinaryPayload,
  context: DocumentImageContext,
): Promise<string | null> {
  if (!context.noteId || !context.filePath) return null;

  const hash = await sha256Hex(payload.bytes);
  const filename = `${hash}.${extFromMime(payload.mime)}`;
  const relativePath = buildAssetRelativePath(context.noteId, filename);
  const absolutePath = resolveAssetAbsolutePath(relativePath, context.filePath);
  if (!absolutePath) return null;

  await mkdir(dirname(absolutePath), { recursive: true }).catch(() => {});
  await writeFile(absolutePath, payload.bytes);
  return relativePath;
}

export async function readImageBinary(
  src: string,
  context: DocumentImageContext,
): Promise<ImageBinaryPayload | null> {
  if (isDataImageSource(src)) {
    return {
      bytes: dataUrlToUint8Array(src),
      mime: mimeFromDataUrl(src),
    };
  }

  const absolutePath = resolveAssetAbsolutePath(src, context.filePath);
  if (!absolutePath) return null;

  const bytes = await readFile(absolutePath);
  const mime = mimeFromExt(extFromPath(absolutePath));
  return { bytes, mime };
}

export async function resolveRenderableImageSource(
  src: string,
  context: DocumentImageContext,
): Promise<string | null> {
  if (isDataImageSource(src)) return src;
  if (!isRelativeAssetSource(src)) return src;

  const absolutePath = resolveAssetAbsolutePath(src, context.filePath);
  if (!absolutePath) return null;

  const cached = renderableSourceCache.get(absolutePath);
  if (cached) return cached;

  const payload = await readImageBinary(src, context);
  if (!payload) return null;

  const dataUrl = bytesToDataUrl(payload.bytes, payload.mime);
  renderableSourceCache.set(absolutePath, dataUrl);
  return dataUrl;
}
