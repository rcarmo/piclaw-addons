/** Host bridge for optional Piclaw tool-status hints. */

export interface ToolStatusHint {
  key?: string;
  icon_svg: string;
  label: string;
  title?: string;
  kind?: string;
}

export interface ToolStatusHintContext {
  chatJid?: string;
  toolName: string;
  args: unknown;
  payload?: Record<string, unknown>;
}

export interface ToolStatusHintProvider {
  id: string;
  buildHints: (context: ToolStatusHintContext) => ToolStatusHint | ToolStatusHint[] | null | undefined;
}

type ToolStatusHintRegistrar = (provider: ToolStatusHintProvider) => void;

export function registerToolStatusHintProvider(provider: ToolStatusHintProvider): void {
  const registrar = (globalThis as Record<string, unknown>).__piclaw_registerToolStatusHintProvider;
  if (typeof registrar === "function") (registrar as ToolStatusHintRegistrar)(provider);
}
