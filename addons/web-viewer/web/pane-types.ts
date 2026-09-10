export type PanePlacement = "tabs" | "dock";
export type PaneCapability = "edit" | "readonly" | "terminal" | "preview";

export interface PaneContext {
  path?: string;
  content?: string;
  mtime?: string;
  size?: number;
  dirty?: boolean;
  preview?: Record<string, unknown>;
  transferState?: Record<string, unknown>;
  mode: "edit" | "view";
}

export interface PaneInstance {
  getContent(): string | undefined;
  isDirty(): boolean;
  setContent?(content: string, mtime: string): void;
  focus(): void;
  resize?(): void;
  dispose(): void;
  onDirtyChange?(cb: (dirty: boolean) => void): void;
  onSaveRequest?(cb: (content: string) => void): void;
  onClose?(cb: () => void): void;
}

export interface WebPaneExtension {
  id: string;
  label: string;
  icon?: string;
  capabilities: PaneCapability[];
  placement: PanePlacement;
  retainOnTabSwitch?: boolean;
  canHandle?(context: PaneContext): boolean | number;
  mount(container: HTMLElement, context: PaneContext): PaneInstance;
}
