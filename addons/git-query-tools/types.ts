/**
 * types.ts — Shared interfaces for git-query-tools extension.
 */

export interface CollectResult {
  output: string;
  totalLines: number;
  totalBytes: number;
  truncated: boolean;
}

export type ToolMeta = Record<string, string | number | boolean | null>;

export interface ToolEnvelope {
  tool: string;
  status: "ok" | "error";
  summary: string;
  content?: string;
  warnings?: string[];
  meta?: ToolMeta;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: string | null;
}
