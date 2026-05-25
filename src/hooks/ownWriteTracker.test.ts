import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  markOwnWrite,
  isOwnWrite,
  isOwnWriteContentMatch,
  pathKey,
  pruneOwnWrites,
  __resetOwnWriteTrackerForTests,
} from "./ownWriteTracker";

beforeEach(() => {
  __resetOwnWriteTrackerForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pathKey", () => {
  it("lowercases and unifies separators", () => {
    expect(pathKey("C:\\Users\\Foo\\Bar.md")).toBe("c:/users/foo/bar.md");
    expect(pathKey("C:/Users/Foo/Bar.md")).toBe("c:/users/foo/bar.md");
  });

  it("normalizes mixed separators that template concatenation produces", () => {
    // `${appDataDir}/notes/${id}.md` on Windows produces a mixed-sep string;
    // the watcher emits the all-backslash form. Both must collapse to one key.
    expect(pathKey("C:\\Users\\foo/notes/abc.md")).toBe(
      pathKey("C:\\Users\\foo\\notes\\abc.md"),
    );
  });

  it("strips the Windows extended-length prefix \\\\?\\", () => {
    // notify on Windows can canonicalize to the verbatim namespace, while our
    // own writeTextFile call uses the plain drive form. Both must match.
    expect(pathKey("\\\\?\\C:\\Users\\foo\\bar.md")).toBe("c:/users/foo/bar.md");
    expect(pathKey("\\\\?\\C:\\Users\\foo\\bar.md")).toBe(
      pathKey("C:\\Users\\foo\\bar.md"),
    );
  });

  it("normalizes \\\\?\\UNC\\ to the plain UNC form", () => {
    expect(pathKey("\\\\?\\UNC\\server\\share\\file.md")).toBe(
      "//server/share/file.md",
    );
    expect(pathKey("\\\\?\\UNC\\server\\share\\file.md")).toBe(
      pathKey("\\\\server\\share\\file.md"),
    );
  });

  it("collapses runs of duplicate separators", () => {
    expect(pathKey("C:\\dir\\\\sub//file.md")).toBe("c:/dir/sub/file.md");
  });

  it("preserves the leading // that marks a UNC path", () => {
    expect(pathKey("\\\\server\\share\\file.md")).toBe("//server/share/file.md");
  });

  it("strips trailing separators without dropping a single-slash root", () => {
    expect(pathKey("C:\\dir\\")).toBe("c:/dir");
    expect(pathKey("/")).toBe("/");
  });

  it("returns empty string for empty input", () => {
    expect(pathKey("")).toBe("");
  });
});

describe("markOwnWrite / isOwnWrite", () => {
  it("recognizes the exact same path as own-write within the grace window", () => {
    markOwnWrite("C:\\notes\\abc.md");
    expect(isOwnWrite("C:\\notes\\abc.md")).toBe(true);
  });

  it("recognizes a watcher event that uses forward slashes", () => {
    // Tauri writeTextFile passed the backslash form; the watcher reports the
    // same file in the forward-slash form. Without canonical key, the
    // watcher would treat this as a remote edit and reconcile every save.
    markOwnWrite("C:\\notes\\abc.md");
    expect(isOwnWrite("c:/notes/abc.md")).toBe(true);
  });

  it("recognizes the file when caller used mixed separators", () => {
    // This is exactly the shape useFileSystem.provisionNoteFile creates:
    // `${notesDir}/${id}.md` where notesDir came from appDataDir() and
    // already has backslashes on Windows.
    markOwnWrite("C:\\Users\\foo\\AppData\\Roaming\\app/notes/xyz.md");
    expect(isOwnWrite("C:\\Users\\foo\\AppData\\Roaming\\app\\notes\\xyz.md")).toBe(true);
  });

  it("recognizes a watcher event reported under the \\\\?\\ extended prefix", () => {
    markOwnWrite("C:\\notes\\abc.md");
    expect(isOwnWrite("\\\\?\\C:\\notes\\abc.md")).toBe(true);
  });

  it("recognizes a UNC path reported via the \\\\?\\UNC\\ prefix", () => {
    markOwnWrite("\\\\share\\team\\notes\\abc.md");
    expect(isOwnWrite("\\\\?\\UNC\\share\\team\\notes\\abc.md")).toBe(true);
  });

  it("ignores a path that was never marked", () => {
    markOwnWrite("C:\\notes\\abc.md");
    expect(isOwnWrite("C:\\notes\\other.md")).toBe(false);
  });

  it("expires marks after the time grace window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    markOwnWrite("C:\\notes\\abc.md");
    expect(isOwnWrite("C:\\notes\\abc.md")).toBe(true);
    vi.setSystemTime(2_500);
    expect(isOwnWrite("C:\\notes\\abc.md")).toBe(false);
  });

  it("pruneOwnWrites removes expired entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    markOwnWrite("C:\\notes\\abc.md");
    vi.setSystemTime(10_000);
    pruneOwnWrites();
    expect(isOwnWrite("C:\\notes\\abc.md")).toBe(false);
  });
});

describe("isOwnWriteContentMatch", () => {
  it("matches when watcher reports the same file under a different path form", async () => {
    // crypto.subtle is async, so the test must wait for the hash to land
    // before checking — same as the real watcher path delay (WATCH_DELAY_MS).
    markOwnWrite("C:\\notes\\abc.md", "hello world");
    await flushPendingHashes();
    expect(await isOwnWriteContentMatch("c:/notes/abc.md", "hello world")).toBe(true);
  });

  it("matches across the \\\\?\\ extended-length prefix", async () => {
    markOwnWrite("C:\\notes\\abc.md", "body");
    await flushPendingHashes();
    expect(
      await isOwnWriteContentMatch("\\\\?\\C:\\notes\\abc.md", "body"),
    ).toBe(true);
  });

  it("returns false when the content differs from anything we wrote", async () => {
    markOwnWrite("C:\\notes\\abc.md", "ours");
    await flushPendingHashes();
    expect(await isOwnWriteContentMatch("c:/notes/abc.md", "theirs")).toBe(false);
  });

  it("consumes the hash so a later identical remote write is not swallowed", async () => {
    markOwnWrite("C:\\notes\\abc.md", "same");
    await flushPendingHashes();
    expect(await isOwnWriteContentMatch("c:/notes/abc.md", "same")).toBe(true);
    expect(await isOwnWriteContentMatch("c:/notes/abc.md", "same")).toBe(false);
  });
});

// markOwnWrite kicks off `void sha256Hex(...).then(...)`. The digest is a real
// async API, so several macrotask + microtask drains are needed to be sure the
// hash has been recorded before we assert.
async function flushPendingHashes(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}
