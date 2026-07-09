import { mkdir, readDir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { bytesToDataUrl, dataUrlToUint8Array, mimeFromDataUrl, mimeFromExt, mimeToExt } from "./imageUtils";
import { isValidNoteId } from "./noteId";
import { isStrictSubpath, normalizeSep } from "./pathUtils";
import { NotenError } from "./notenError";
import { logNotenError } from "./crashLog";

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

const MAX_RENDERABLE_SOURCE_CACHE_ENTRIES = 128;
const MAX_RENDERABLE_SOURCE_CACHE_CHARS = 16 * 1024 * 1024;

interface RenderableSourceCacheEntry {
  dataUrl: string;
  size: number;
}

const renderableSourceCache = new Map<string, RenderableSourceCacheEntry>();
let renderableSourceCacheChars = 0;
let renderableSourceCacheGeneration = 0;

function normalizeCacheKey(path: string): string {
  return toUnixPath(path);
}

function removeRenderableSourceCacheEntry(key: string): void {
  const existing = renderableSourceCache.get(key);
  if (!existing) return;
  renderableSourceCache.delete(key);
  renderableSourceCacheChars -= existing.size;
}

function invalidateRenderableSourceCache(): void {
  renderableSourceCacheGeneration += 1;
}

function getCachedRenderableSource(absolutePath: string): string | null {
  const key = normalizeCacheKey(absolutePath);
  const cached = renderableSourceCache.get(key);
  if (!cached) return null;
  renderableSourceCache.delete(key);
  renderableSourceCache.set(key, cached);
  return cached.dataUrl;
}

function setCachedRenderableSource(absolutePath: string, dataUrl: string): void {
  const key = normalizeCacheKey(absolutePath);
  removeRenderableSourceCacheEntry(key);
  const size = dataUrl.length;
  renderableSourceCache.set(key, { dataUrl, size });
  renderableSourceCacheChars += size;

  while (
    renderableSourceCache.size > MAX_RENDERABLE_SOURCE_CACHE_ENTRIES
    || renderableSourceCacheChars > MAX_RENDERABLE_SOURCE_CACHE_CHARS
  ) {
    const oldest = renderableSourceCache.keys().next().value as string | undefined;
    if (!oldest) break;
    removeRenderableSourceCacheEntry(oldest);
  }
}

export function clearRenderableImageSourceCache(): void {
  renderableSourceCache.clear();
  renderableSourceCacheChars = 0;
  invalidateRenderableSourceCache();
}

export function evictRenderableImageSourceCachePath(absolutePath: string): void {
  removeRenderableSourceCacheEntry(normalizeCacheKey(absolutePath));
  invalidateRenderableSourceCache();
}

export function evictRenderableImageSourceCachePrefix(absolutePathPrefix: string): void {
  const prefix = normalizeCacheKey(absolutePathPrefix).replace(/\/+$/, "");
  for (const key of Array.from(renderableSourceCache.keys())) {
    if (key === prefix || key.startsWith(`${prefix}/`)) {
      removeRenderableSourceCacheEntry(key);
    }
  }
  invalidateRenderableSourceCache();
}

export async function removeNoteAssetDir(notesDir: string, noteId: string): Promise<void> {
  if (!notesDir || !noteId) return;
  // This is a recursive delete: an unsafe id is catastrophic here. `..` makes
  // `.assets/..` resolve to the notes root and wipe every note. Reject the id,
  // then re-verify the built path is strictly inside `.assets/` before removing.
  if (!isValidNoteId(noteId)) {
    void logNotenError(new NotenError(
      "INVALID_NOTE_ID",
      "recoverable",
      "removeNoteAssetDir: refusing recursive delete for unsafe id",
      { context: { notesDir, noteId } },
    ));
    return;
  }
  const assetsRoot = `${normalizeSep(notesDir)}.assets`;
  const dir = `${assetsRoot}/${noteId}`;
  if (!isStrictSubpath(assetsRoot, dir)) {
    void logNotenError(new NotenError(
      "INVALID_NOTE_ID",
      "recoverable",
      "removeNoteAssetDir: refusing recursive delete outside .assets",
      { context: { notesDir, noteId, dir } },
    ));
    return;
  }
  evictRenderableImageSourceCachePrefix(dir);
  try {
    await remove(dir, { recursive: true });
  } catch {
    // Directory may not exist (note had no images) — ignore
  }
}

// Copy a source note's asset files into the duplicate's own asset dir and
// rewrite the markdown so its `.assets/<sourceId>/` references point at the
// new note. Without this a duplicated note keeps pointing at the source's
// asset dir, so permanently deleting the source (or the 14-day trash purge)
// runs `removeNoteAssetDir(sourceId)` and silently breaks the duplicate's
// images. Returns the rewritten content; on any guard failure it returns the
// content unchanged so the caller still gets a usable (if image-broken) copy.
export async function duplicateNoteAssets(
  notesDir: string,
  sourceId: string,
  newId: string,
  content: string,
): Promise<string> {
  if (!notesDir || !sourceId || !newId || sourceId === newId) return content;
  // These paths are id-derived and drive recursive-ish file ops; reject unsafe
  // ids and re-verify both dirs resolve strictly inside `.assets/` first.
  if (!isValidNoteId(sourceId) || !isValidNoteId(newId)) {
    void logNotenError(new NotenError(
      "INVALID_NOTE_ID",
      "recoverable",
      "duplicateNoteAssets: refusing asset copy for unsafe id",
      { context: { notesDir, sourceId, newId } },
    ));
    return content;
  }
  const assetsRoot = `${normalizeSep(notesDir)}.assets`;
  const sourceDir = `${assetsRoot}/${sourceId}`;
  const targetDir = `${assetsRoot}/${newId}`;
  if (!isStrictSubpath(assetsRoot, sourceDir) || !isStrictSubpath(assetsRoot, targetDir)) {
    return content;
  }

  let entries: Awaited<ReturnType<typeof readDir>>;
  try {
    entries = await readDir(sourceDir);
  } catch {
    // Source note has no asset dir — nothing to copy, and no matching
    // references to rewrite.
    return content;
  }

  await mkdir(targetDir, { recursive: true }).catch(() => {});
  const copied = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile) continue;
    try {
      const bytes = await readFile(`${sourceDir}/${entry.name}`);
      await writeFile(`${targetDir}/${entry.name}`, bytes);
      copied.add(entry.name);
    } catch (err) {
      // Copy failed (locked OneDrive placeholder, read-only dir, disk full).
      // Leave this asset's references pointing at the SOURCE dir below — the
      // source file still exists, so the image renders now, instead of
      // rewriting to a `.assets/<newId>/` file that was never created (which
      // would break the image immediately). The reference reverts to the
      // pre-fix shared-asset state only for this one file.
      void logNotenError(new NotenError(
        "SAVE_FAILED",
        "recoverable",
        err instanceof Error ? err.message : String(err),
        { context: { stage: "duplicateNoteAssets", sourceId, newId, file: entry.name } },
      ));
    }
  }

  // Rewrite only the references whose asset was actually copied; a failed copy
  // keeps its `.assets/<sourceId>/<file>` reference so it still resolves. The
  // per-file key is shared by the markdown `](...)` and serialized
  // `<img src="...">` forms and survives a leading `./`. Content-hash
  // filenames are fixed-shape, so no key is a substring of another.
  let rewritten = content;
  for (const filename of copied) {
    rewritten = rewritten
      .split(`.assets/${sourceId}/${filename}`)
      .join(`.assets/${newId}/${filename}`);
  }
  return rewritten;
}

export function resolveAssetAbsolutePath(src: string, noteFilePath: string | null): string | null {
  if (!noteFilePath || !isRelativeAssetSource(src)) return null;
  const normalizedSrc = stripLeadingCurrentDir(src.trim());
  return `${dirname(noteFilePath)}/${normalizedSrc}`;
}

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
  evictRenderableImageSourceCachePath(absolutePath);
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
  evictRenderableImageSourceCachePath(absolutePath);
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
  // Only data:image and managed .assets/ sources are renderable. Anything
  // else — http(s), protocol-relative, file:, absolute local paths — is
  // refused (null → the <img> gets no src). A remote URL here would fire a
  // network request the moment the note is opened, violating the "notes
  // never leave the disk" invariant and acting as a tracking pixel.
  if (!isRelativeAssetSource(src)) return null;

  const absolutePath = resolveAssetAbsolutePath(src, context.filePath);
  if (!absolutePath) return null;

  const cached = getCachedRenderableSource(absolutePath);
  if (cached) return cached;

  const cacheGeneration = renderableSourceCacheGeneration;
  const payload = await readImageBinary(src, context);
  if (!payload) return null;

  const dataUrl = bytesToDataUrl(payload.bytes, payload.mime);
  if (cacheGeneration === renderableSourceCacheGeneration) {
    setCachedRenderableSource(absolutePath, dataUrl);
  }
  return dataUrl;
}
