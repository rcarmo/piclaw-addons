export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function action<T = any>(
  name: string,
  payload: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch("/agent/addons/api/code-review/action", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, action: name }),
    signal,
  });
  const body = await response.json();
  if (!response.ok || !body.ok)
    throw new ApiError(
      body.error?.code || "failed",
      body.error?.message || body.error || "Review request failed.",
      body.error?.status || response.status,
    );
  return body.result;
}
export const requestId = () => crypto.randomUUID();
export const escapeText = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
