import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildShellArgs, createExecSessionManager, type ExecSessionManager } from "./exec-session-manager.ts";

const managers: ExecSessionManager[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.shutdown();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manager(options: Parameters<typeof createExecSessionManager>[0] = {}): ExecSessionManager {
	const value = createExecSessionManager({
		ptyBackend: "bun",
		defaultExecYieldTimeMs: 1_000,
		defaultWriteYieldTimeMs: 250,
		minNonInteractiveExecYieldTimeMs: 250,
		minEmptyWriteYieldTimeMs: 250,
		...options,
	});
	managers.push(value);
	return value;
}

const shell = process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/bash";
const commands = process.platform === "win32"
	? {
		print: (value: string) => `<nul set /p =${value}`,
		cwdEnv: "<nul set /p =cwd=%cd%;marker=%CODEX_TEST_MARKER%",
		interactive: "set /p value=& <nul set /p =input=%value%",
		delay: "ping 127.0.0.1 -n 6 >nul",
		exit: (code: number) => `exit /b ${code}`,
	}
	: {
		print: (value: string) => `printf %s ${JSON.stringify(value)}`,
		cwdEnv: "printf 'cwd=%s;marker=%s' \"$PWD\" \"$CODEX_TEST_MARKER\"",
		interactive: "read -r value; printf 'input=%s' \"$value\"",
		delay: "sleep 5",
		exit: (code: number) => `exit ${code}`,
	};

async function waitForExit(manager: ExecSessionManager, sessionId: number) {
	let result = await manager.write({ session_id: sessionId, yield_time_ms: 250 });
	for (let attempt = 0; result.session_id && attempt < 40; attempt += 1) {
		result = await manager.write({ session_id: sessionId, yield_time_ms: 250 });
	}
	return result;
}

test("buildShellArgs preserves POSIX login behavior and supports Windows shells", () => {
	expect(buildShellArgs("/bin/bash", "echo ok", true)).toEqual(["-lc", "echo ok"]);
	expect(buildShellArgs("/bin/bash", "echo ok", false)).toEqual(["-c", "echo ok"]);
	expect(buildShellArgs("cmd.exe", "echo ok", true)).toEqual(["/d", "/s", "/c", "echo ok"]);
	expect(buildShellArgs("pwsh", "echo ok", true)).toEqual(["-NoLogo", "-NoProfile", "-Command", "echo ok"]);
});

test("pipe sessions preserve cwd, environment, output, exit code, and command history", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-pipe-"));
	tempDirs.push(cwd);
	const previous = process.env.CODEX_TEST_MARKER;
	process.env.CODEX_TEST_MARKER = "present";
	try {
		const sessions = manager();
		const result = await sessions.exec({ cmd: commands.cwdEnv, shell, tty: false, yield_time_ms: 1_000 }, cwd);
		expect(result.output).toContain(`cwd=${cwd}`);
		expect(result.output).toContain("marker=present");
		expect(result.exit_code).toBe(0);
	} finally {
		if (previous === undefined) delete process.env.CODEX_TEST_MARKER;
		else process.env.CODEX_TEST_MARKER = previous;
	}
});

test("Bun PTY sessions preserve incremental output, interactive writes, and exit codes", async () => {
	const backends: string[] = [];
	const sessions = manager({ onPtyBackend: (backend) => backends.push(backend) });
	const started = await sessions.exec({ cmd: commands.interactive, shell, tty: true, yield_time_ms: 250 }, process.cwd());
	expect(started.session_id).toBeNumber();
	const sessionId = started.session_id!;
	expect(sessions.hasSession(sessionId)).toBe(true);

	const completed = await sessions.write({ session_id: sessionId, chars: "hello world\n", yield_time_ms: 1_000 });
	expect(completed.output).toContain("input=hello world");
	expect(completed.exit_code).toBe(0);
	expect(sessions.getSessionCommand(sessionId)).toBe(commands.interactive);
	expect(backends).toEqual(["bun"]);
});

test("PTY output normalization handles ANSI cursor rewrites and output truncation", async () => {
	if (process.platform === "win32") return;
	const sessions = manager();
	const rewritten = await sessions.exec({
		cmd: "printf 'step 1\\r\\033[Kstep 2\\n'",
		shell,
		tty: true,
		yield_time_ms: 1_000,
	}, process.cwd());
	expect(rewritten.output).toBe("step 2\n");

	const truncated = await sessions.exec({
		cmd: "printf '0123456789%.0s' {1..200}",
		shell,
		tty: true,
		yield_time_ms: 1_000,
		max_output_tokens: 64,
	}, process.cwd());
	expect(truncated.output.length).toBe(256);
	expect(truncated.original_token_count).toBeGreaterThan(64);
});

test("abort terminates a running PTY session and reports its terminal exit", async () => {
	const sessions = manager();
	const abort = new AbortController();
	const started = await sessions.exec({ cmd: commands.delay, shell, tty: true, yield_time_ms: 250 }, process.cwd(), abort.signal);
	expect(started.session_id).toBeNumber();
	abort.abort();
	const completed = await waitForExit(sessions, started.session_id!);
	expect(completed.exit_code).toBeNumber();
	expect(sessions.hasSession(started.session_id!)).toBe(false);
});

test("shutdown terminates sessions, clears history, and repeated sessions remain independent", async () => {
	const sessions = manager();
	const first = await sessions.exec({ cmd: commands.print("first"), shell, tty: true, yield_time_ms: 1_000 }, process.cwd());
	const second = await sessions.exec({ cmd: commands.print("second"), shell, tty: true, yield_time_ms: 1_000 }, process.cwd());
	expect(first.output).toContain("first");
	expect(second.output).toContain("second");

	const running = await sessions.exec({ cmd: commands.delay, shell, tty: true, yield_time_ms: 250 }, process.cwd());
	expect(running.session_id).toBeNumber();
	sessions.shutdown();
	expect(sessions.hasSession(running.session_id!)).toBe(false);
	expect(sessions.getSessionCommand(running.session_id!)).toBeUndefined();
});

test("pipe output strips ANSI/control bytes and normalizes newlines", async () => {
	if (process.platform === "win32") return;
	const cwd = mkdtempSync(join(tmpdir(), "codex-pipe-normalize-"));
	tempDirs.push(cwd);
	writeFileSync(join(cwd, "emit.sh"), "printf '\\033[31mred\\033[0m\\r\\nnext\\rline\\001'\n");
	const sessions = manager();
	const result = await sessions.exec({ cmd: "bash emit.sh", shell, tty: false, yield_time_ms: 1_000 }, cwd);
	expect(result.output).toBe("red\nnext\nline");
});
