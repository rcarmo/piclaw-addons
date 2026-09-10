/**
 * file-conflict-monitor.ts — Stub for @rcarmo/piclaw-addon-mindmap.
 *
 * The full conflict monitor needs piclaw's internal /workspace/stat API.
 * This stub provides the same interface but does nothing, keeping the
 * mindmap pane functional without the conflict detection feature.
 */

export interface FileConflictMonitorOptions {
  path: string;
  getCurrentMtime: () => string | null;
  anchorParent?: HTMLElement;
  anchorBefore?: HTMLElement | null;
  onReload: () => Promise<void> | void;
  onSaveCopy: (copyPath: string) => Promise<void> | void;
  onOverwrite: () => Promise<void> | void;
}

export interface FileConflictMonitor {
  start(): void;
  stop(): void;
  dispose(): void;
  onSaved(newMtime: string | null): void;
}

export function createFileConflictMonitor(_options: FileConflictMonitorOptions): FileConflictMonitor {
  return {
    start() {},
    stop() {},
    dispose() {},
    onSaved(_newMtime: string | null) {},
  };
}
