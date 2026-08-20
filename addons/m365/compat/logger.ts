/** Lightweight logger shim for the standalone M365 add-on. */

export interface Logger {
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  debug(message: string, metadata?: Record<string, unknown>): void;
}

function write(method: "log" | "warn" | "error" | "debug", prefix: string, message: string, metadata?: Record<string, unknown>): void {
  console[method](prefix, message, metadata ? JSON.stringify(metadata) : "");
}

export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  return {
    info: (message, metadata) => write("log", prefix, message, metadata),
    warn: (message, metadata) => write("warn", prefix, message, metadata),
    error: (message, metadata) => write("error", prefix, message, metadata),
    debug: (message, metadata) => {
      if (process.env.DEBUG) write("debug", prefix, message, metadata);
    },
  };
}

export function debugSuppressedError(logger: Logger, message: string, error: unknown, metadata: Record<string, unknown> = {}): void {
  if (process.env.DEBUG) logger.debug(message, { ...metadata, error: String(error) });
}
