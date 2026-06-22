export type NotenSeverity = "recoverable" | "fatal";

export type NotenErrorCode =
  | "RECONCILE_FAILED"
  | "PERSIST_FAILED"
  | "SAVE_FAILED"
  | "META_WRITE_FAILED"
  | "BODY_READ_FAILED"
  | "BACKUP_FAILED"
  | "CONFLICT_SCAN_FAILED"
  | "TRASH_PURGE_FAILED"
  | "INVALID_NOTE_ID"
  | "WATCH_SETUP_FAILED"
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

  constructor(
    code: NotenErrorCode,
    severity: NotenSeverity,
    message: string,
    options: NotenErrorOptions = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "NotenError";
    this.code = code;
    this.severity = severity;
    if (options.context) this.context = options.context;
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
