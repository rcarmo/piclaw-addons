/**
 * constants.ts — Shared constants for git-query-tools extension.
 */

export const encoder = new TextEncoder();
export const DEFAULT_MAX_LINES = 200;
export const DEFAULT_MAX_BYTES = 51200;
export const DEFAULT_TIMEOUT = 30_000;
export const FAST_TIMEOUT = 10_000;
export const MAX_PROCESS_OUTPUT = 10 * 1024 * 1024;
export const BASE_DIR = "/workspace";
