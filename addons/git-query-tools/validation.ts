/**
 * validation.ts — Path security and input validation helpers for git-query-tools.
 */

import { resolve, relative } from "node:path";
import { BASE_DIR } from "./constants.js";

export function safePath(file: string | undefined): { resolved: string; error?: string } {
  if (!file) return { resolved: BASE_DIR };
  const resolved = resolve(BASE_DIR, file);
  if (!resolved.startsWith(BASE_DIR + "/") && resolved !== BASE_DIR) {
    return { resolved: "", error: "path outside workspace" };
  }
  return { resolved };
}

export function relPath(file: string): string {
  const r = resolve(BASE_DIR, file);
  return relative(BASE_DIR, r);
}

const JQ_DENYLIST =
  /(?:^|\b)(env|debug|input|inputs|halt|stderr|builtins)(?:\b|$)|\$ENV|\$__loc__|\bpath\s*\(|\bgetpath\b/;

/**
 * Returns an error string if the jq expression uses blocked builtins, or null if safe.
 * Allows .env (key access) but blocks bare `env`, `$ENV`, etc.
 */
export function checkJqExpression(expr: string): string | null {
  const stripped = expr.replace(/\.\w+/g, "");
  if (JQ_DENYLIST.test(stripped)) return "blocked jq builtin";
  return null;
}

export function validateText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (!t) return `'${field}' cannot be empty`;
  if (/\r|\n/.test(t)) return `'${field}' must be a single-line value`;
  if (!/[A-Za-z0-9]/.test(t)) return `'${field}' must contain at least one letter or number`;
  return undefined;
}

export function parseBlameLines(lines?: string): { normalized?: string; error?: string } {
  if (!lines) return {};
  const t = lines.trim();
  if (!t) return { error: "'lines' cannot be empty for blame mode" };
  const single = t.match(/^(\d+)$/);
  if (single) {
    const n = Number(single[1]);
    if (n < 1) return { error: "'lines' must be positive integers" };
    return { normalized: `${n},${n}` };
  }
  const range = t.match(/^(\d+)(,|:|\.\.|-)(\d+)$/);
  if (!range) {
    return {
      error:
        "'lines' must be a single line like '10' or a range like '10,20', '10:20', '10..20', or '10-20'",
    };
  }
  const start = Number(range[1]);
  const end = Number(range[3]);
  if (start < 1 || end < 1) return { error: "'lines' must use positive integers" };
  if (start > end) return { error: "'lines' start must be <= end" };
  return { normalized: `${start},${end}` };
}
