/**
 * compat/tool-status-hints.ts — Tool status hint registry shim for standalone addons.
 * Matches piclaw's tool-status-hints.ts interface.
 */

export interface ToolStatusHint {
  key?: string;
  icon_svg: string;
  label: string;
  title?: string;
  kind?: string;
}

export interface ToolStatusHintContext {
  chatJid: string;
  toolName: string;
  args: unknown;
  payload: Record<string, unknown>;
}

export interface ToolStatusHintProvider {
  id: string;
  buildHints: (context: ToolStatusHintContext) => ToolStatusHint[] | ToolStatusHint | null | undefined;
}

const providers = new Map<string, ToolStatusHintProvider>();

export function registerToolStatusHintProvider(provider: ToolStatusHintProvider): void {
  if (!provider?.id || typeof provider.buildHints !== "function") return;
  providers.set(provider.id, provider);
}

export function resolveToolStatusHints(context: ToolStatusHintContext): ToolStatusHint[] {
  const resolved: ToolStatusHint[] = [];
  for (const provider of providers.values()) {
    try {
      const candidate = provider.buildHints(context);
      const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : [];
      for (const hint of list) {
        if (hint?.icon_svg?.trim() && hint?.label?.trim()) {
          resolved.push(hint);
        }
      }
    } catch {
      continue;
    }
  }
  return resolved;
}
