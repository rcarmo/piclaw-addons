export interface RunOptions {
  binary: string;
  args: string[];
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  redact?: string[];
}
export interface RunResult { code: number; stdout: string; stderr: string; durationMs: number; }
export interface BackupSource { name: string; path: string; }
export interface StageManifest {
  version: 1;
  sources: BackupSource[];
  files: Array<{ path: string; sha256: string; sqlite: boolean }>;
}
export interface StageResult { directory: string; manifest: StageManifest; cleanup(): void; }
