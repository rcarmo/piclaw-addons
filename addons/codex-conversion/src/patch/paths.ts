import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { DiffError } from "./types.ts";

export function normalizePatchPath({ path }: { path: string }): string {
	const trimmed = path.trim();
	const withoutAt = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
	return withoutAt.replace(/^['"]|['"]$/g, "");
}

// Relative patch paths stay anchored to ctx.cwd. Absolute patch paths are
// accepted as-is so the adapter can match Codex-style path usage.
export function resolvePatchPath({ cwd, patchPath }: { cwd: string; patchPath: string }): string {
	const normalized = normalizePatchPath({ path: patchPath });
	if (!normalized) {
		throw new DiffError("Patch path cannot be empty");
	}

	const absolutePath = isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
	const rel = relative(cwd, absolutePath);
	if (!isAbsolute(normalized) && (rel.startsWith("..") || isAbsolute(rel))) {
		throw new DiffError(`Path escapes working directory: ${normalized}`);
	}
	return absolutePath;
}

export interface PatchFilePorts {
 existsSync: typeof existsSync;
 mkdirSync: typeof mkdirSync;
 readFileSync: typeof readFileSync;
 unlinkSync: typeof unlinkSync;
 writeFileSync: typeof writeFileSync;
}

/** Invocation-local ports; never swaps global filesystem authority. */
export function createPatchPaths(ops: PatchFilePorts) {
function openFileAtPath({ cwd, path }: { cwd: string; path: string }): string {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	if (!ops.existsSync(absolutePath)) {
		throw new DiffError(`File not found: ${path}`);
	}
	return ops.readFileSync(absolutePath, "utf8");
}

function writeFileAtPath({ cwd, path, content }: { cwd: string; path: string; content: string }): { created: boolean } {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	const created = !ops.existsSync(absolutePath);
	ops.mkdirSync(dirname(absolutePath), { recursive: true });
	ops.writeFileSync(absolutePath, content, "utf8");
	return { created };
}

function removeFileAtPath({ cwd, path }: { cwd: string; path: string }): void {
	const absolutePath = resolvePatchPath({ cwd, patchPath: path });
	if (!ops.existsSync(absolutePath)) {
		throw new DiffError(`File not found: ${path}`);
	}
	ops.unlinkSync(absolutePath);
}

function pathExists({ cwd, path }: { cwd: string; path: string }): boolean {
	return ops.existsSync(resolvePatchPath({ cwd, patchPath: path }));
}

return { openFileAtPath, writeFileAtPath, removeFileAtPath, pathExists };
}
export const { openFileAtPath, writeFileAtPath, removeFileAtPath, pathExists } = createPatchPaths({ existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync });
