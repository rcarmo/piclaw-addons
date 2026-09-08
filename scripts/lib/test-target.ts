/** External browser tests need an explicitly declared disposable target. */
export function requireDisposableTestTarget(value: string | undefined, env: Record<string, string | undefined> = process.env): string {
  if (!value?.trim() || env.PICLAW_E2E_DISPOSABLE !== "1") {
    throw new Error("Set an explicit E2E URL and PICLAW_E2E_DISPOSABLE=1 for a disposable test instance; live targets are not defaults.");
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Test target must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}
