/** Piclaw display metadata. The tool owns wording and sensitive-field selection.
 * Pure, synchronous, argument-only callbacks; never capture an execution context.
 * This helper is vendored into each standalone package, with no Core imports.
 */
export type ToolCallSummary = (args: unknown) => string | null | undefined;
export const toolCallSummary = (callSummary: ToolCallSummary) => ({ callSummary });
export function summaryArgs(input: unknown): Readonly<Record<string, unknown>> {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { return {}; }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
export function summaryValue(input: unknown): string | null {
  const text = typeof input === 'string' ? input.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
    : typeof input === 'number' && Number.isFinite(input) ? String(input) : '';
  if (!text) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|https?:|\/\/)/i.test(text)) {
    try {
      const url = new URL(text.startsWith('//') ? `https:${text}` : text);
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return text.startsWith('//') ? url.toString().slice('https:'.length) : url.toString();
    } catch { return '[invalid URL]'; }
  }
  return text.replace(/^[^\s/:@\\]+:[^\s/@\\]*@(?=[^/\s]+\/)/, '');
}
export const summaryJoin = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(' · ');
export const summaryFields = (args: Readonly<Record<string, unknown>>, ...keys: string[]) => keys.map(key => summaryValue(args[key])).filter(Boolean).join(' · ');
export const summaryFirst = (args: Readonly<Record<string, unknown>>, ...keys: string[]) => keys.map(key => summaryValue(args[key])).find(Boolean) ?? null;
export const summaryChoice = (input: unknown, allowed: string) => typeof input === 'string'
  ? allowed.split(' ').find(item => item.toLowerCase() === input.trim().toLowerCase()) ?? '' : '';
export const summaryWords = (input: string) => input.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ');
export const summaryPath = (input: unknown) => summaryValue(input)?.split(/[?#]/)[0] ?? null;
export const summaryMethod = (input: unknown) => typeof input === 'string' && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/i.test(input) ? input.toUpperCase() : 'GET';
export function summaryRequest(args: Readonly<Record<string, unknown>>): string {
  const requests = Array.isArray(args.requests) ? args.requests : [];
  const request = requests.length ? summaryArgs(requests[0]) : args;
  const path = summaryPath(request.path);
  const label = path ? `${summaryMethod(request.method)} ${path}` : 'API request';
  return requests.length ? summaryJoin(`${requests.length} API request${requests.length === 1 ? '' : 's'}`, label) : label;
}
