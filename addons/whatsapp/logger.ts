export interface AddonLogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export function createLogger(scope: string): AddonLogger {
  const prefix = `[${scope}]`;
  return {
    info: (message, context) => console.info(prefix, message, context ?? ""),
    warn: (message, context) => console.warn(prefix, message, context ?? ""),
    error: (message, context) => console.error(prefix, message, context ?? ""),
  };
}

export function debugSuppressedError(
  logger: AddonLogger,
  message: string,
  error: unknown,
  context?: Record<string, unknown>,
): void {
  logger.warn(message, { ...context, error });
}
