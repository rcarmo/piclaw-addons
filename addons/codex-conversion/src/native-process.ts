import { Type } from "typebox";
import { createExecSessionManager, type ExecSessionManagerOptions, type ExecCommandInput, type WriteStdinInput } from "./tools/exec-session-manager.ts";
import { formatUnifiedExecResult } from "./tools/unified-exec-format.ts";

export interface ProcessIdentity { chatId: string; ownerIncarnation: string; sessionRevision: string; }
export interface ProcessInvocation extends ProcessIdentity { cwd: string; signal?: AbortSignal; assertCurrent(): void; }
/** One pool per application owner, never per tool call. Handles are memory-only. */
export function createNativeProcessPool(options: ExecSessionManagerOptions = {}) {
  const manager = createExecSessionManager(options);
  const owners = new Map<number, string>();
  let disposed = false;
  const key = (p: ProcessIdentity) => JSON.stringify([p.chatId, p.ownerIncarnation, p.sessionRevision]);
  const check = (p: ProcessInvocation) => { if (disposed) throw Error("Disposed process pool"); p.signal?.throwIfAborted(); p.assertCurrent(); };
  return {
    async exec(p: ProcessInvocation, input: ExecCommandInput) {
      check(p);
      const result = await manager.exec(input, p.cwd, p.signal, () => check(p));
      if (result.session_id !== undefined) owners.set(result.session_id, key(p));
      return result;
    },
    async write(p: ProcessInvocation, input: WriteStdinInput) {
      check(p);
      if (owners.get(input.session_id) !== key(p)) throw Error("Unauthorized process handle");
      const result = await manager.write(input, p.signal, () => check(p));
      if (result.exit_code !== undefined) owners.delete(input.session_id);
      return result;
    },
    disposeSession(p: ProcessIdentity, id: number) {
      if (owners.get(id) !== key(p)) throw Error("Unauthorized process handle");
      manager.disposeSession(id); owners.delete(id);
    },
    disposeIdentity(p: ProcessIdentity) {
      for (const [id, owner] of owners) if (owner === key(p)) { manager.disposeSession(id); owners.delete(id); }
    },
    dispose() { disposed = true; manager.shutdown(); owners.clear(); },
  };
}
export type NativeProcessPool = ReturnType<typeof createNativeProcessPool>;
const execSchema = Type.Object({ cmd: Type.String(), workdir: Type.Optional(Type.String()), shell: Type.Optional(Type.String()), tty: Type.Optional(Type.Boolean()), login: Type.Optional(Type.Boolean()), yield_time_ms: Type.Optional(Type.Number()), max_output_tokens: Type.Optional(Type.Number()) });
const writeSchema = Type.Object({ session_id: Type.Number(), chars: Type.Optional(Type.String()), yield_time_ms: Type.Optional(Type.Number()), max_output_tokens: Type.Optional(Type.Number()) });
export function createNativeExecCommandTool(pool: NativeProcessPool, p: ProcessInvocation) {
  return { name: "exec_command", label: "exec_command", description: "Run a command", parameters: execSchema,
    async execute(_id: string, input: ExecCommandInput) {
      if (typeof input?.cmd !== "string") throw Error("exec_command requires cmd");
      const result = await pool.exec(p, input);
      return { content: [{ type: "text" as const, text: formatUnifiedExecResult(result, input.cmd) }], details: result };
    } };
}
export function createNativeWriteStdinTool(pool: NativeProcessPool, p: ProcessInvocation) {
  return { name: "write_stdin", label: "write_stdin", description: "Write to or poll a process", parameters: writeSchema,
    async execute(_id: string, input: WriteStdinInput) {
      if (!Number.isSafeInteger(input?.session_id)) throw Error("write_stdin requires session_id");
      const result = await pool.write(p, input);
      return { content: [{ type: "text" as const, text: formatUnifiedExecResult(result) }], details: result };
    } };
}
