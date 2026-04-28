/**
 * compat/logger.ts — Lightweight logger shim for standalone addons.
 * Replaces piclaw's utils/logger.ts without any internal dependencies.
 */

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(name: string): Logger {
  const prefix = `[${name}]`;
  return {
    info: (msg, meta) => console.log(prefix, msg, meta ? JSON.stringify(meta) : ""),
    warn: (msg, meta) => console.warn(prefix, msg, meta ? JSON.stringify(meta) : ""),
    error: (msg, meta) => console.error(prefix, msg, meta ? JSON.stringify(meta) : ""),
    debug: (msg, meta) => {
      if (process.env.DEBUG) console.debug(prefix, msg, meta ? JSON.stringify(meta) : "");
    },
  };
}

export function debugSuppressedError(_logger: Logger, msg: string, error: unknown, meta?: Record<string, unknown>): void {
  if (process.env.DEBUG) {
    _logger.debug(msg, { ...(meta || {}), err: String(error) });
  }
}
