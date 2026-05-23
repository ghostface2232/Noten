import {
  readTextFile as tauriReadTextFile,
  writeTextFile as tauriWriteTextFile,
  readFile as tauriReadFile,
  writeFile as tauriWriteFile,
  mkdir as tauriMkdir,
  remove as tauriRemove,
  copyFile as tauriCopyFile,
  rename as tauriRename,
  readDir as tauriReadDir,
  exists as tauriExists,
  stat as tauriStat,
} from "@tauri-apps/plugin-fs";

export interface DirEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  mtime: Date | null;
  birthtime: Date | null;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface FileSystem {
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, content: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  remove(path: string, options?: RemoveOptions): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
}

export const tauriFileSystem: FileSystem = {
  readTextFile: (path) => tauriReadTextFile(path),
  writeTextFile: (path, content) => tauriWriteTextFile(path, content),
  readFile: (path) => tauriReadFile(path),
  writeFile: (path, data) => tauriWriteFile(path, data),
  mkdir: (path, options) => tauriMkdir(path, options),
  remove: (path, options) => tauriRemove(path, options),
  copyFile: (from, to) => tauriCopyFile(from, to),
  rename: (from, to) => tauriRename(from, to),
  readDir: async (path) => {
    const entries = await tauriReadDir(path);
    return entries.map((e) => ({
      name: e.name,
      isFile: e.isFile,
      isDirectory: e.isDirectory,
      isSymlink: e.isSymlink,
    }));
  },
  exists: (path) => tauriExists(path),
  stat: async (path) => {
    const info = await tauriStat(path);
    return {
      isFile: info.isFile,
      isDirectory: info.isDirectory,
      isSymlink: info.isSymlink,
      size: info.size,
      mtime: info.mtime,
      birthtime: info.birthtime,
    };
  },
};
