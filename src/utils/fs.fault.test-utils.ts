import type { FileSystem } from "./fs";

// Fault-injection wrapper for FileSystem. Layers on top of any inner
// implementation (typically `createInMemoryFileSystem()`) so tests can
// reproduce the real-world failure modes that the bare in-memory FS is too
// forgiving to model:
//
//   - OneDrive/Dropbox/GDrive placeholders: `stat` rejects transiently, or
//     returns `{ mtime: null }` even when readDir lists the entry.
//   - Antivirus / sync clients holding files: `rename` rejects with EBUSY
//     until the lock clears (atomicWriteText's degradation path).
//   - Network mounts: any op can throw on a flaky connection.
//   - Permission / scope errors: `exists` rejects instead of returning false.
//   - Disk full / quota: `writeTextFile` rejects mid-flow.
//
// Rules are evaluated in insertion order; the first match wins. Each rule
// optionally limits how many times it fires via `times`, letting tests model
// "fails twice then recovers" without manual retry counters.

type FsOp = keyof FileSystem;

export interface FaultRule {
  /** Operation to intercept. */
  op: FsOp;
  /** Path matcher. String = exact path match. RegExp = `test(path)`. Omitted = match every path. */
  path?: string | RegExp;
  /** Maximum number of times this rule fires before retiring. Default: unlimited. */
  times?: number;
  /** Action: throw this when the rule fires, before invoking the inner op. */
  throwError?: Error;
  /** Action: transform the inner op's result. Ignored when `throwError` is set. */
  transformResult?: (result: unknown) => unknown;
}

export interface FaultInjectingFileSystem extends FileSystem {
  injectFault(rule: FaultRule): void;
  clearFaults(): void;
  /** Total invocations of `op`, optionally filtered by path matcher. Counts every call, intercepted or not. */
  callCount(op: FsOp, path?: string | RegExp): number;
}

export function wrapWithFaults<T extends FileSystem>(inner: T): T & FaultInjectingFileSystem {
  const rules: FaultRule[] = [];
  const counts = new Map<string, number>();

  function bump(op: FsOp, path: string): void {
    const key = `${op}|${path}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  function pathMatches(rule: FaultRule, path: string): boolean {
    if (rule.path === undefined) return true;
    if (typeof rule.path === "string") return rule.path === path;
    return rule.path.test(path);
  }

  function consumeRule(op: FsOp, path: string): FaultRule | undefined {
    for (const r of rules) {
      if (r.op !== op) continue;
      if (!pathMatches(r, path)) continue;
      if (r.times !== undefined) {
        if (r.times <= 0) continue;
        r.times -= 1;
      }
      return r;
    }
    return undefined;
  }

  async function intercept<R>(op: FsOp, path: string, run: () => Promise<R>): Promise<R> {
    bump(op, path);
    const rule = consumeRule(op, path);
    if (rule?.throwError) throw rule.throwError;
    const result = await run();
    if (rule?.transformResult) return rule.transformResult(result) as R;
    return result;
  }

  // `inner` first so its non-FileSystem helpers (seedTextFile, snapshot, ...)
  // are preserved; the FileSystem methods are then overridden by interceptors.
  const wrapped: T & FaultInjectingFileSystem = {
    ...inner,
    readTextFile: (path) =>
      intercept("readTextFile", path, () => inner.readTextFile(path)),
    writeTextFile: (path, content) =>
      intercept("writeTextFile", path, () => inner.writeTextFile(path, content)),
    readFile: (path) =>
      intercept("readFile", path, () => inner.readFile(path)),
    writeFile: (path, data) =>
      intercept("writeFile", path, () => inner.writeFile(path, data)),
    mkdir: (path, options) =>
      intercept("mkdir", path, () => inner.mkdir(path, options)),
    remove: (path, options) =>
      intercept("remove", path, () => inner.remove(path, options)),
    // Two-path ops match on the source. Tests targeting the destination can
    // still use a RegExp that covers both endpoints.
    copyFile: (from, to) =>
      intercept("copyFile", from, () => inner.copyFile(from, to)),
    rename: (from, to) =>
      intercept("rename", from, () => inner.rename(from, to)),
    readDir: (path) =>
      intercept("readDir", path, () => inner.readDir(path)),
    exists: (path) =>
      intercept("exists", path, () => inner.exists(path)),
    stat: (path) =>
      intercept("stat", path, () => inner.stat(path)),

    injectFault(rule) {
      rules.push({ ...rule });
    },
    clearFaults() {
      rules.length = 0;
    },
    callCount(op, path) {
      let total = 0;
      for (const [key, value] of counts) {
        const sep = key.indexOf("|");
        const keyOp = key.slice(0, sep);
        const keyPath = key.slice(sep + 1);
        if (keyOp !== op) continue;
        if (path === undefined) { total += value; continue; }
        if (typeof path === "string") {
          if (keyPath === path) total += value;
        } else if (path.test(keyPath)) {
          total += value;
        }
      }
      return total;
    },
  };

  return wrapped;
}
