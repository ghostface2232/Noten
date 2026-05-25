import type { DirEntry, FileStat, FileSystem } from "./fs";

// Known divergences from `@tauri-apps/plugin-fs` — tests must accommodate:
// - Error messages use POSIX-style prefixes (`ENOENT:`, `EEXIST:`, ...) that do
//   NOT match the real plugin's Rust/OS-formatted strings. Assert on
//   `.rejects.toThrow()` shape only, never on the message text.
// - `exists()` never throws here; the real plugin can reject on scope or
//   permission errors. Production code already uses `.catch(() => false)` in
//   the paths that care.
// - `stat()` always returns concrete `Date` values for `mtime`/`birthtime`. The
//   real plugin may return `null` on some platforms; null-handling branches
//   won't be exercised by tests against this implementation.
// - `rename` always succeeds if validation passes; `atomicWrite.ts`'s
//   rename-failure fallback path will never run here.

interface FileNode {
  kind: "file";
  data: Uint8Array;
  birthtime: Date;
  mtime: Date;
}

interface DirNode {
  kind: "dir";
  birthtime: Date;
  mtime: Date;
}

type Node = FileNode | DirNode;

// Windows drive letters become a child of `/` so they can't form a parallel
// root invisible to `readDir("/")`: `C:\Users\x` → `/C:/Users/x`. Collapsing
// `//` runs brings the test FS into parity with how real OS filesystems treat
// repeated separators, so accidental `${dir}/${name}` patterns where `dir`
// already ends in `/` don't fail here while silently succeeding in production.
function normalize(path: string): string {
  let p = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(p)) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function parentOf(path: string): string {
  const p = normalize(path);
  const idx = p.lastIndexOf("/");
  if (idx <= 0) return "/";
  return p.slice(0, idx);
}

function basenameOf(path: string): string {
  const p = normalize(path);
  const idx = p.lastIndexOf("/");
  return idx < 0 ? p : p.slice(idx + 1);
}

function encodeText(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function decodeText(data: Uint8Array): string {
  return new TextDecoder().decode(data);
}

export interface InMemoryFileSystem extends FileSystem {
  /** Test helper: dump the entire FS as a map of path → contents (text or bytes). */
  snapshot(): Map<string, Uint8Array | "<dir>">;
  /** Test helper: pre-seed text files. Creates parent directories as needed. */
  seedTextFile(path: string, content: string): void;
  /** Test helper: pre-seed binary files. Creates parent directories as needed. */
  seedFile(path: string, data: Uint8Array): void;
  /** Test helper: pre-seed an empty directory tree. */
  seedDir(path: string): void;
}

export function createInMemoryFileSystem(): InMemoryFileSystem {
  const nodes = new Map<string, Node>();
  nodes.set("/", { kind: "dir", birthtime: new Date(), mtime: new Date() });

  function getNode(path: string): Node | undefined {
    return nodes.get(normalize(path));
  }

  function requireFile(path: string): FileNode {
    const node = getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, ${path}`);
    if (node.kind !== "file") throw new Error(`EISDIR: is a directory, ${path}`);
    return node;
  }

  function requireDir(path: string): DirNode {
    const node = getNode(path);
    if (!node) throw new Error(`ENOENT: no such file or directory, ${path}`);
    if (node.kind !== "dir") throw new Error(`ENOTDIR: not a directory, ${path}`);
    return node;
  }

  function ensureParentDir(path: string): void {
    const parent = parentOf(path);
    const node = getNode(parent);
    if (!node) throw new Error(`ENOENT: parent directory does not exist, ${parent}`);
    if (node.kind !== "dir") throw new Error(`ENOTDIR: parent is not a directory, ${parent}`);
  }

  function touchParent(path: string): void {
    const parent = parentOf(path);
    const node = nodes.get(parent);
    if (node && node.kind === "dir") node.mtime = new Date();
  }

  function mkdirRecursive(path: string): void {
    const p = normalize(path);
    if (p === "/" || nodes.has(p)) {
      const existing = nodes.get(p);
      if (existing && existing.kind !== "dir") {
        throw new Error(`EEXIST: path exists and is not a directory, ${p}`);
      }
      return;
    }
    mkdirRecursive(parentOf(p));
    const now = new Date();
    nodes.set(p, { kind: "dir", birthtime: now, mtime: now });
    touchParent(p);
  }

  function writeFileNode(path: string, data: Uint8Array): void {
    const p = normalize(path);
    ensureParentDir(p);
    const existing = nodes.get(p);
    if (existing && existing.kind === "dir") {
      throw new Error(`EISDIR: cannot overwrite directory with file, ${p}`);
    }
    const now = new Date();
    const birthtime = existing && existing.kind === "file" ? existing.birthtime : now;
    nodes.set(p, { kind: "file", data: new Uint8Array(data), birthtime, mtime: now });
    touchParent(p);
  }

  function removeNode(path: string, recursive: boolean): void {
    const p = normalize(path);
    const node = nodes.get(p);
    if (!node) throw new Error(`ENOENT: no such file or directory, ${p}`);
    if (node.kind === "dir") {
      const children = childPaths(p);
      if (children.length > 0 && !recursive) {
        throw new Error(`ENOTEMPTY: directory not empty, ${p}`);
      }
      for (const child of children) nodes.delete(child);
    }
    nodes.delete(p);
    touchParent(p);
  }

  function childPaths(dir: string): string[] {
    const d = normalize(dir);
    const prefix = d === "/" ? "/" : `${d}/`;
    const out: string[] = [];
    for (const key of nodes.keys()) {
      if (key === d) continue;
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  function directChildren(dir: string): string[] {
    const d = normalize(dir);
    const prefix = d === "/" ? "/" : `${d}/`;
    const out: string[] = [];
    for (const key of nodes.keys()) {
      if (key === d) continue;
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest.includes("/")) out.push(key);
    }
    return out;
  }

  function nodeToDirEntry(path: string, node: Node): DirEntry {
    return {
      name: basenameOf(path),
      isFile: node.kind === "file",
      isDirectory: node.kind === "dir",
      isSymlink: false,
    };
  }

  function nodeToStat(node: Node): FileStat {
    const size = node.kind === "file" ? node.data.byteLength : 0;
    return {
      isFile: node.kind === "file",
      isDirectory: node.kind === "dir",
      isSymlink: false,
      size,
      mtime: node.mtime,
      birthtime: node.birthtime,
    };
  }

  const fs: InMemoryFileSystem = {
    async readTextFile(path) {
      return decodeText(requireFile(path).data);
    },
    async writeTextFile(path, content) {
      writeFileNode(path, encodeText(content));
    },
    async readFile(path) {
      return new Uint8Array(requireFile(path).data);
    },
    async writeFile(path, data) {
      writeFileNode(path, data);
    },
    async mkdir(path, options) {
      const p = normalize(path);
      if (nodes.has(p)) {
        const existing = nodes.get(p)!;
        if (existing.kind !== "dir") {
          throw new Error(`EEXIST: path exists and is not a directory, ${p}`);
        }
        if (!options?.recursive) {
          throw new Error(`EEXIST: directory already exists, ${p}`);
        }
        return;
      }
      if (options?.recursive) {
        mkdirRecursive(p);
        return;
      }
      ensureParentDir(p);
      const now = new Date();
      nodes.set(p, { kind: "dir", birthtime: now, mtime: now });
      touchParent(p);
    },
    async remove(path, options) {
      removeNode(path, options?.recursive === true);
    },
    async copyFile(from, to) {
      const src = requireFile(from);
      writeFileNode(to, src.data);
    },
    async rename(from, to) {
      const src = normalize(from);
      const dst = normalize(to);
      const node = nodes.get(src);
      if (!node) throw new Error(`ENOENT: no such file or directory, ${from}`);
      if (dst === src) throw new Error(`EINVAL: source and destination are the same, ${from}`);
      const srcPrefixCheck = src === "/" ? "/" : `${src}/`;
      if (dst.startsWith(srcPrefixCheck)) {
        throw new Error(`EINVAL: cannot rename into a subdirectory of itself, ${from} -> ${to}`);
      }
      ensureParentDir(dst);
      const existing = nodes.get(dst);
      if (existing) {
        if (existing.kind === "dir") {
          throw new Error(`EISDIR: cannot overwrite directory via rename, ${to}`);
        }
        nodes.delete(dst);
      }
      if (node.kind === "file") {
        nodes.set(dst, { ...node, mtime: new Date() });
        nodes.delete(src);
      } else {
        const children = childPaths(src);
        nodes.set(dst, { ...node, mtime: new Date() });
        nodes.delete(src);
        const srcPrefix = src === "/" ? "/" : `${src}/`;
        const dstPrefix = dst === "/" ? "/" : `${dst}/`;
        for (const child of children) {
          const moved = `${dstPrefix}${child.slice(srcPrefix.length)}`;
          nodes.set(moved, nodes.get(child)!);
          nodes.delete(child);
        }
      }
      touchParent(src);
      touchParent(dst);
    },
    async readDir(path) {
      requireDir(path);
      return directChildren(path).map((child) => nodeToDirEntry(child, nodes.get(child)!));
    },
    async exists(path) {
      return nodes.has(normalize(path));
    },
    async stat(path) {
      const node = getNode(path);
      if (!node) throw new Error(`ENOENT: no such file or directory, ${path}`);
      return nodeToStat(node);
    },
    snapshot() {
      const out = new Map<string, Uint8Array | "<dir>">();
      for (const [key, node] of nodes) {
        if (key === "/") continue;
        out.set(key, node.kind === "file" ? new Uint8Array(node.data) : "<dir>");
      }
      return out;
    },
    seedTextFile(path, content) {
      mkdirRecursive(parentOf(path));
      writeFileNode(path, encodeText(content));
    },
    seedFile(path, data) {
      mkdirRecursive(parentOf(path));
      writeFileNode(path, data);
    },
    seedDir(path) {
      mkdirRecursive(path);
    },
  };

  return fs;
}
