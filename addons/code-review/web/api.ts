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
export const requestId = () => {
  // randomUUID is unavailable on HTTP pages reached by a non-local hostname.
  // getRandomValues remains available there; never use a predictable fallback.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
export const escapeText = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

/** Existing host profiles are presentation only; they never confer review authority. */
export type ReviewProfiles = {
  user?: { name?: string | null; avatar_url?: string | null };
  agents?: Array<{ name?: string | null; avatar_url?: string | null }>;
};
export async function loadReviewProfiles(signal?: AbortSignal): Promise<ReviewProfiles> {
  try {
    const response = await fetch('/agent/roster', { credentials: 'same-origin', signal });
    if (!response.ok) return {};
    const body = await response.json();
    return body && typeof body === 'object' ? body : {};
  } catch { return {}; /* A missing profile must not prevent review access. */ }
}
export function reviewAuthor(
  kind: unknown, authorId: unknown, profiles: ReviewProfiles, targets: any[],
): { name: string; avatar: string | null } {
  if (kind !== 'operator' && kind !== 'agent') return { name: 'Unknown author', avatar: null };
  const agent = Array.isArray(profiles.agents) ? profiles.agents[0] : undefined;
  const target = kind === 'agent' && typeof authorId === 'string'
    ? targets.find(item => item.incarnation === authorId) : undefined;
  const profileName = kind === 'operator' ? profiles.user?.name : target ? agent?.name : null;
  const name = typeof profileName === 'string' && profileName.trim()
    ? profileName.trim() : kind === 'operator' ? 'You' : 'Agent';
  const handle = typeof target?.agentName === 'string' ? target.agentName.trim() : '';
  const avatar = kind === 'operator' ? profiles.user?.avatar_url : target ? agent?.avatar_url : null;
  return {
    name: handle && handle.toLowerCase() !== name.toLowerCase() ? `${name} (@${handle})` : name,
    avatar: safeReviewAvatar(avatar),
  };
}
function safeReviewAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const url = value.trim();
  if (url.startsWith('/') && !url.startsWith('//') && !url.includes('\\') && !/[\u0000-\u0020]/.test(url)) return url;
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : null;
  } catch { return null; }
}
