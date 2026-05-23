import { appDataDir } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  isNotenError,
  notifyFatal,
  NotenError,
  type NotenErrorCode,
  type NotenErrorContext,
  type NotenSeverity,
} from "./notenError";

const MAX_LOG_BYTES = 500 * 1024;
const MAX_STACK_CHARS = 4000;
const utf8Encoder = new TextEncoder();
const INSTALLED_SENTINEL = "__notenCrashLogInstalled" as const;

let crashLogPathPromise: Promise<string> | null = null;
let writeChain: Promise<void> = Promise.resolve();

async function resolveCrashLogPath(): Promise<string> {
  const base = await appDataDir();
  try {
    await mkdir(base, { recursive: true });
  } catch { /* dir exists or unavailable; write attempt will surface real failure */ }
  const sep = base.endsWith("/") || base.endsWith("\\") ? "" : "/";
  return `${base}${sep}crash.log`;
}

function getCrashLogPath(): Promise<string> {
  if (!crashLogPathPromise) crashLogPathPromise = resolveCrashLogPath();
  return crashLogPathPromise;
}

function formatLine(
  severity: NotenSeverity,
  code: NotenErrorCode | string,
  message: string,
  context?: NotenErrorContext,
  stack?: string,
): string {
  const ts = new Date().toISOString();
  let line = `[${ts}] [${severity}] [${code}] ${message}\n`;
  if (context && Object.keys(context).length > 0) {
    let serialized: string;
    try {
      serialized = JSON.stringify(context);
    } catch {
      serialized = "[unserializable]";
    }
    line += `  context: ${serialized}\n`;
  }
  if (stack) {
    const truncated = stack.length > MAX_STACK_CHARS
      ? `${stack.slice(0, MAX_STACK_CHARS)}…[truncated]`
      : stack;
    line += `  stack: ${truncated.replace(/\n/g, "\n         ")}\n`;
  }
  return line;
}

// Trims `existing` so that appending the new `line` keeps the file under the
// byte cap, snapping the surviving prefix to a newline boundary so the file
// never begins mid-entry. Always preserves the new line itself — it is the
// most diagnostically valuable entry in a crash log.
function trimExistingForAppend(existing: string, lineBytes: number): string {
  const existingBytes = utf8Encoder.encode(existing).length;
  if (existingBytes + lineBytes <= MAX_LOG_BYTES) return existing;

  // Drop the older portion; keep roughly half of the cap minus space the new
  // line needs. If the line alone is larger than the cap, start from empty.
  const headroom = Math.max(0, Math.floor(MAX_LOG_BYTES / 2) - lineBytes);
  if (headroom === 0) return "";

  // Approximate cut by chars, then iteratively shrink until byte budget fits.
  // Cheap path: most logs are mostly ASCII so one pass usually suffices.
  let tail = existing.slice(Math.max(0, existing.length - headroom));
  while (utf8Encoder.encode(tail).length > headroom && tail.length > 0) {
    tail = tail.slice(Math.ceil(tail.length / 8));
  }
  const nlIdx = tail.indexOf("\n");
  return nlIdx >= 0 ? tail.slice(nlIdx + 1) : "";
}

async function appendLine(line: string): Promise<void> {
  try {
    const path = await getCrashLogPath();
    let existing = "";
    try {
      if (await exists(path)) {
        existing = await readTextFile(path);
      }
    } catch { /* unreadable; start fresh */ }
    const lineBytes = utf8Encoder.encode(line).length;
    const trimmed = trimExistingForAppend(existing, lineBytes);
    await writeTextFile(path, trimmed + line);
  } catch {
    // Crash logger must never throw.
  }
}

function enqueue(line: string): Promise<void> {
  const job = writeChain.then(() => appendLine(line));
  writeChain = job.catch(() => undefined);
  return job;
}

// The wrap-site stack on NotenError points only at the catch block; the cause's
// stack identifies the actual failure origin and is preferred when present.
function preferredStack(error: NotenError): string | undefined {
  if (error.cause instanceof Error && error.cause.stack) return error.cause.stack;
  return error.stack;
}

export function logNotenError(error: NotenError): Promise<void> {
  notifyFatal(error);
  return enqueue(formatLine(
    error.severity,
    error.code,
    error.message,
    error.context,
    preferredStack(error),
  ));
}

function extractUncaughtMessage(value: unknown, fallback: string): string {
  if (value instanceof Error) return value.message || fallback;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function initCrashLog(): void {
  if (typeof window === "undefined") return;
  // Survives Vite HMR module re-evaluation — listeners are global, not modular.
  const w = window as typeof window & { [INSTALLED_SENTINEL]?: boolean };
  if (w[INSTALLED_SENTINEL]) return;
  w[INSTALLED_SENTINEL] = true;

  window.addEventListener("error", (event) => {
    const err = (event as ErrorEvent).error;
    if (isNotenError(err)) {
      void logNotenError(err);
      return;
    }
    const message = extractUncaughtMessage(err, (event as ErrorEvent).message || "Unknown error");
    const stack = err instanceof Error ? err.stack : undefined;
    void enqueue(formatLine("fatal", "UNCAUGHT", message, undefined, stack));
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    if (isNotenError(reason)) {
      void logNotenError(reason);
      return;
    }
    const message = extractUncaughtMessage(reason, "Unhandled rejection");
    const stack = reason instanceof Error ? reason.stack : undefined;
    void enqueue(formatLine("fatal", "UNCAUGHT", message, undefined, stack));
  });
}
