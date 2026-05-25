import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// Project-specific contract tests. These are NOT exhaustive — they enforce a
// handful of invariants from recent regressions that ESLint cannot easily
// express (cross-file call-shape rules, presence of named constants, etc.).
//
// Style: grep over source text. Cheap to add, cheap to maintain, low ceremony.
// If a check needs real AST analysis, prefer adding an ESLint rule instead.

const SRC_ROOT = resolve(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.ts$|\.test-utils\.ts$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

describe("contract: setNotesDir / resetNotesDir callers pass reconcile state", () => {
  // Regression: src/App.tsx:206-218 (commit f8f7b58). The settings-driven
  // effect was the only caller that omitted reconcileStateRef.current, which
  // silently disabled the 2-pass body-missing safeguard on cross-window dir
  // changes. The implementation lives in useNotesLoader.ts and is the only
  // file allowed to mention these names without the argument.
  const IMPL_FILE = "hooks/useNotesLoader.ts";
  const CALL_RE = /\b(?:setNotesDir|resetNotesDir)\s*\(/g;

  it("every external call site mentions reconcileState on the same line", () => {
    const violations: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (file.replace(/\\/g, "/").endsWith(IMPL_FILE)) continue;
      const lines = read(file).split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (!CALL_RE.test(line)) {
          CALL_RE.lastIndex = 0;
          continue;
        }
        CALL_RE.lastIndex = 0;
        if (!/reconcileState/i.test(line)) {
          violations.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(violations, violations.join("\n")).toEqual([]);
  });
});

describe("contract: crashLog line caps remain in place", () => {
  // Regression: src/utils/crashLog.ts (commit bc358f9). Without these caps a
  // single pathological entry (e.g., unhandled rejection with a huge reason)
  // can exceed the 250KB threshold in trimExistingForAppend and wipe all
  // prior history.
  const CRASH_LOG = resolve(SRC_ROOT, "utils/crashLog.ts");

  it("declares MAX_MESSAGE_CHARS, MAX_CONTEXT_CHARS, and MAX_STACK_CHARS", () => {
    const text = read(CRASH_LOG);
    expect(text).toMatch(/\bMAX_MESSAGE_CHARS\s*=/);
    expect(text).toMatch(/\bMAX_CONTEXT_CHARS\s*=/);
    expect(text).toMatch(/\bMAX_STACK_CHARS\s*=/);
  });

  it("applies each cap inside formatLine", () => {
    const text = read(CRASH_LOG);
    const fnMatch = text.match(/function formatLine[\s\S]*?\n\}/);
    expect(fnMatch, "formatLine not found").not.toBeNull();
    const body = fnMatch![0];
    expect(body).toMatch(/MAX_MESSAGE_CHARS/);
    expect(body).toMatch(/MAX_CONTEXT_CHARS/);
    expect(body).toMatch(/MAX_STACK_CHARS/);
  });
});
