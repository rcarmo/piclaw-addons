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
  getCurrentContent: () => string;
  onConflict: (externalMtime: string) => void;
}

export interface FileConflictMonitor {
  start(): void;
  stop(): void;
  onSaved(newMtime: string): void;
}

export function createFileConflictMonitor(_options: FileConflictMonitorOptions): FileConflictMonitor {
  return {
    start() {},
    stop() {},
    onSaved(_newMtime: string) {},
  };
}
