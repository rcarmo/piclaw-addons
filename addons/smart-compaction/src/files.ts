/**
 * Extracted smart-compaction helper module.
 *
 * Keep this module focused; the public extension facade remains
 * ../smart-compaction.ts.
 */

import type { FileOperations } from "./types.js";

// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a file path: strip the workspace prefix so all paths are
 * workspace-relative. Tool calls record paths inconsistently — some
 * absolute (`/workspace/foo`), some relative (`foo`). Without this,
 * `compressFilePaths` can't find a common prefix and the output bloats.
 */
const CWD_PREFIX = process.cwd().endsWith("/") ? process.cwd() : process.cwd() + "/";
function normalizePath(p: string): string {
  if (p.startsWith(CWD_PREFIX)) return p.slice(CWD_PREFIX.length);
  // Also handle bare /workspace/ when cwd is /workspace
  if (p.startsWith("/") && !p.startsWith(CWD_PREFIX) && p.startsWith(process.cwd())) {
    return p.slice(process.cwd().length + 1);
  }
  return p;
}

function normalizePathSet(paths: Iterable<string>): string[] {
  const seen = new Set<string>();
  for (const p of paths) {
    seen.add(normalizePath(p));
  }
  return [...seen];
}

/** Compute final read-only / modified file lists from FileOperations. */
export function fileListsFromOps(fileOps: FileOperations): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const modified = new Set(filterJunkPaths(normalizePathSet([...fileOps.written, ...fileOps.edited])));
  const readOnly = filterJunkPaths(normalizePathSet([...fileOps.read]).filter((f) => !modified.has(f)));
  return { readFiles: readOnly, modifiedFiles: [...modified] };
}

/**
 * Filter out paths that are noise rather than meaningful project context.
 * These are temp files, device nodes, session logs, and similar paths that
 * clutter the read-files list without helping the LLM understand the project.
 */
const JUNK_PATH_PATTERNS: RegExp[] = [
  /^\/dev\//,                          // device nodes (/dev/stdin, /dev/null)
  /^\/var\/log\//,                     // host log files
  /^\/proc\//,                         // proc filesystem
  /^\/sys\//,                          // sys filesystem
  /^(?:\/tmp|tmp)\//,                  // host temp files or workspace tmp/
  /(?:^|\/)\.piclaw\/tmp\//,          // piclaw temp files
  /(?:^|\/)\.cache\//,                // cache dirs
  /(?:^|\/)node_modules\//,           // dependency trees
  /(?:^|\/)\.pi\/agent\/sessions\//,  // pi session files
  /(?:^|\/)\.pi\/agent\/models\.json$/, // pi model config
  /(?:^|\/)\.pi\/agent\/settings\.json$/, // pi settings
  /(?:^|\/)bun\.lock$/,               // lockfiles
  /(?:^|\/)package-lock\.json$/,
  /\.jsonl$/,                          // session/log jsonl files
  /\.wasm$/,                           // binary blobs
  /\.map$/,                            // source maps
  /\.min\.js$/,                        // minified bundles
  /\.bundle\.(js|css)$/,               // bundles
  /\.meta\.json$/,                     // meta files
];

/**
 * Find the longest common directory prefix for a set of paths.
 * Returns a prefix ending in `/`, or an empty string when no shared
 * directory prefix exists.
 */
function findCommonDirectoryPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (!paths[i].startsWith(prefix)) {
      const slash = prefix.lastIndexOf("/", prefix.length - 2);
      if (slash < 0) return "";
      prefix = prefix.slice(0, slash + 1);
    }
  }
  return prefix;
}

/**
 * Group paths by their top-level root so unrelated outliers (`tmp/...`)
 * do not destroy compression for the main cluster (`piclaw/...`).
 */
function topLevelPathKey(path: string): string {
  if (!path.includes("/")) return "";
  if (path.startsWith("/")) {
    const trimmed = path.slice(1);
    const slash = trimmed.indexOf("/");
    return slash >= 0 ? `/${trimmed.slice(0, slash + 1)}` : path;
  }
  const slash = path.indexOf("/");
  return slash >= 0 ? path.slice(0, slash + 1) : "";
}

/** Render a single compressed path cluster. */
function renderCompressedPathCluster(paths: string[]): string {
  if (paths.length === 0) return "(none)";
  const sorted = [...paths].sort();
  const prefix = findCommonDirectoryPrefix(sorted);

  const groups = new Map<string, string[]>();
  for (const p of sorted) {
    const rel = prefix ? p.slice(prefix.length) : p;
    const lastSlash = rel.lastIndexOf("/");
    const dir = lastSlash >= 0 ? rel.slice(0, lastSlash + 1) : "";
    const file = lastSlash >= 0 ? rel.slice(lastSlash + 1) : rel;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(file);
  }

  const lines: string[] = [];
  if (prefix) lines.push(`base: ${prefix}`);
  for (const [dir, files] of [...groups.entries()].sort()) {
    if (files.length === 1) {
      lines.push(`${dir}${files[0]}`);
    } else {
      lines.push(`${dir || "./"}: ${files.join(", ")}`);
    }
  }
  return lines.join("\n");
}

/**
 * Compress a list of file paths by factoring out common prefixes and,
 * when needed, compressing multiple top-level clusters independently.
 *
 * Example:
 *   piclaw/runtime/web/src/ui/app.ts
 *   piclaw/runtime/web/src/ui/theme.ts
 *   piclaw/runtime/test/web/app.test.ts
 *   tmp/report.patch
 * →
 *   base: piclaw/runtime/
 *   web/src/ui/: app.ts, theme.ts
 *   test/web/: app.test.ts
 *   tmp/report.patch
 */
export function compressFilePaths(paths: string[]): string {
  if (paths.length === 0) return "(none)";
  const uniqueSorted = [...new Set(paths)].sort();
  if (uniqueSorted.length <= 3) return uniqueSorted.join("\n");

  const globalPrefix = findCommonDirectoryPrefix(uniqueSorted);
  if (globalPrefix) return renderCompressedPathCluster(uniqueSorted);

  const clusters = new Map<string, string[]>();
  for (const path of uniqueSorted) {
    const key = topLevelPathKey(path);
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key)!.push(path);
  }

  if (clusters.size <= 1) return renderCompressedPathCluster(uniqueSorted);

  const lines: string[] = [];
  for (const key of [...clusters.keys()].sort()) {
    const cluster = clusters.get(key)!;
    if (cluster.length === 1) {
      lines.push(cluster[0]);
      continue;
    }
    lines.push(renderCompressedPathCluster(cluster));
  }
  return lines.join("\n");
}

export function filterJunkPaths(paths: string[]): string[] {
  return paths.filter((p) => !JUNK_PATH_PATTERNS.some((re) => re.test(p)));
}
