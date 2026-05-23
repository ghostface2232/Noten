export type NotenSeverity = "recoverable" | "fatal";

export type NotenErrorCode =
  | "RECONCILE_FAILED"
  | "PERSIST_FAILED"
  | "SAVE_FAILED"
  | "META_WRITE_FAILED"
  | "MIGRATION_FAILED"
  | "UNCAUGHT";

export interface NotenErrorContext {
  noteId?: string;
  filePath?: string;
  [key: string]: unknown;
}

export interface NotenErrorOptions {
  context?: NotenErrorContext;
  cause?: unknown;
}

export class NotenError extends Error {
  readonly code: NotenErrorCode;
  readonly severity: NotenSeverity;
  readonly context?: NotenErrorContext;
  readonly cause?: unknown;

  constructor(
    code: NotenErrorCode,
    severity: NotenSeverity,
    message: string,
    options: NotenErrorOptions = {},
  ) {
    super(message);
    this.name = "NotenError";
    this.code = code;
    this.severity = severity;
    if (options.context) this.context = options.context;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export function isNotenError(value: unknown): value is NotenError {
  return value instanceof NotenError;
}

let fatalHandler: ((error: NotenError) => void) | null = null;

export function registerFatalHandler(handler: ((error: NotenError) => void) | null): void {
  fatalHandler = handler;
}

export function notifyFatal(error: NotenError): void {
  if (error.severity !== "fatal" || !fatalHandler) return;
  try {
    fatalHandler(error);
  } catch {
    // Handler failure must not propagate.
  }
}
