/** Separate native executable entry. No legacy ToolDefinition or session context. */
import { formatPatchSuccess, formatPatchError } from "./patch/tool-result.ts";
import { createPatchExecutor } from "./patch/core.ts";
import type { PatchFilePorts } from "./patch/paths.ts";

export interface NativePatchAuthority {
  /** Must check captured host operation, session and source identity at each effect. */
  assertCurrent(): void;
}

/** Synchronous filesystem admission only: no async work may escape a port call.
 * Host ports own path policy; absolute paths intentionally retain legacy semantics.
 */
export function createNativeApplyPatchFactory(files: PatchFilePorts) {
  return (authority: NativePatchAuthority, cwd: string) => {
    let disposed = false;
    const check = () => {
      if (disposed) throw Error("Disposed native patch invocation");
      authority.assertCurrent();
    };
    const guarded = <K extends keyof PatchFilePorts>(key: K): PatchFilePorts[K] =>
      ((...args: unknown[]) => {
        check();
        return (files[key] as (...args: unknown[]) => unknown)(...args);
      }) as PatchFilePorts[K];
    const executePatch = createPatchExecutor({
      existsSync: guarded("existsSync"), readFileSync: guarded("readFileSync"),
      mkdirSync: guarded("mkdirSync"), writeFileSync: guarded("writeFileSync"),
      unlinkSync: guarded("unlinkSync"),
    });
    return Object.freeze({
      name: "apply_patch" as const,
      execute(params: { input: string }) {
        check();
        if (typeof params?.input !== "string") throw Error("apply_patch requires a string 'input' parameter");
        return executePatch({ cwd, patchText: params.input });
      },
      executeTool(params: { input: string }) {
        check();
        if (typeof params?.input !== "string") throw Error("apply_patch requires a string 'input' parameter");
        let result;
        try { result = executePatch({ cwd, patchText: params.input }); }
        catch (error) {
          check();
          const formatted = formatPatchError(error, cwd);
          check();
          return formatted;
        }
        check();
        const formatted = formatPatchSuccess(result);
        check();
        return formatted;
      },
      dispose() { disposed = true; },
    });
  };
}
