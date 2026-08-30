import { afterEach, expect, test } from "bun:test";

import { spawnManagedPty, type ManagedPty } from "./pty-backend.ts";

const children: ManagedPty[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.dispose();
});

function shellCommand(command: string): { file: string; args: string[] } {
	if (process.platform === "win32") {
		return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { file: "/bin/bash", args: ["-lc", command] };
}

async function runPty(command: string, options: {
	backend?: "bun" | "node-pty";
	interact?: (child: ManagedPty) => Promise<void>;
} = {}) {
	let output = "";
	let selectedBackend = "";
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
	const { file, args } = shellCommand(command);
	const child = await spawnManagedPty(file, args, {
		cwd: process.cwd(),
		env: { ...process.env, TERM: "xterm-256color" },
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		backend: options.backend ?? "bun",
		onBackend: (backend) => { selectedBackend = backend; },
		onData: (data) => { output += data; },
		onExit: resolveExit,
	});
	children.push(child);
	await options.interact?.(child);
	const exitCode = await Promise.race([
		exited,
		Bun.sleep(10_000).then(() => { throw new Error(`PTY command timed out: ${command}`); }),
	]);
	return { child, output, exitCode, selectedBackend };
}

test("Bun PTY exposes 80x24 dimensions and a controlling foreground terminal on POSIX", async () => {
	if (process.platform === "win32") return;
	const result = await runPty("printf 'tty=%s size=%s sid=%s pgid=%s tpgid=%s' \"$(test -t 0 && echo yes || echo no)\" \"$(stty size)\" \"$(ps -o sid= -p $$|xargs)\" \"$(ps -o pgid= -p $$|xargs)\" \"$(ps -o tpgid= -p $$|xargs)\"");
	const match = result.output.match(/tty=yes size=24 80 sid=(\d+) pgid=(\d+) tpgid=(\d+)/);
	expect(match).not.toBeNull();
	expect(match?.[1]).toBe(match?.[2]);
	expect(match?.[2]).toBe(match?.[3]);
	expect(result.exitCode).toBe(0);
});

test("Bun PTY supports interactive input and resize", async () => {
	const command = process.platform === "win32"
		? "set /p value=& <nul set /p =input=%value%"
		: "read -r value; sleep .1; printf 'input=%s size=%s' \"$value\" \"$(stty size)\"";
	const result = await runPty(command, {
		interact: async (child) => {
			child.resize(120, 40);
			child.write(process.platform === "win32" ? "hello world\r" : "hello world\n");
		},
	});
	expect(result.output).toContain("input=hello world");
	if (process.platform !== "win32") expect(result.output).toContain("size=40 120");
	expect(result.exitCode).toBe(0);
});

test("Bun PTY reports real subprocess exit codes", async () => {
	const result = await runPty(process.platform === "win32" ? "exit /b 7" : "exit 7");
	expect(result.exitCode).toBe(7);
	expect(result.selectedBackend).toBe("bun");
});

test("Bun PTY kill terminates the process tree without leaking background work", async () => {
	let output = "";
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
	const command = process.platform === "win32"
		? "start /b ping 127.0.0.1 -n 60 >nul & echo ready & ping 127.0.0.1 -n 60 >nul"
		: "sleep 60 & bg=$!; printf 'shell=%s bg=%s\\n' $$ $bg; wait";
	const { file, args } = shellCommand(command);
	const child = await spawnManagedPty(file, args, {
		cwd: process.cwd(), env: process.env, name: "xterm-256color", cols: 80, rows: 24, backend: "bun",
		onData: (data) => { output += data; }, onExit: resolveExit,
	});
	children.push(child);
	const readyPattern = process.platform === "win32" ? /ready/i : /shell=(\d+) bg=(\d+)/;
	for (let attempt = 0; !readyPattern.test(output) && attempt < 100; attempt += 1) await Bun.sleep(10);
	const match = output.match(readyPattern);
	expect(match).not.toBeNull();
	const rootPid = child.pid;
	expect(rootPid).toBeNumber();
	child.kill("SIGTERM");
	await exited;
	await Bun.sleep(100);
	const alive = (pid: number) => {
		try { process.kill(pid, 0); return true; } catch { return false; }
	};
	expect(alive(rootPid!)).toBe(false);
	if (process.platform !== "win32") expect(alive(Number(match?.[2]))).toBe(false);
});

test("forced node-pty rollback remains operational in a fresh runtime", async () => {
	const moduleUrl = new URL("./pty-backend.ts", import.meta.url).href;
	const command = shellCommand(process.platform === "win32" ? "<nul set /p =fallback" : "printf fallback");
	const script = [
		`import { spawnManagedPty } from ${JSON.stringify(moduleUrl)};`,
		`let output = "";`,
		`let resolveExit; const exited = new Promise((resolve) => { resolveExit = resolve; });`,
		`const child = await spawnManagedPty(${JSON.stringify(command.file)}, ${JSON.stringify(command.args)}, { cwd: process.cwd(), env: process.env, name: "xterm-256color", cols: 80, rows: 24, backend: "node-pty", onData: (data) => { output += data; }, onExit: resolveExit });`,
		`const exitCode = await exited; child.dispose(); console.log(JSON.stringify({ backend: child.backend, output, exitCode }));`,
	].join("\n");
	const proc = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	expect(JSON.parse(stdout)).toEqual({ backend: "node-pty", output: "fallback", exitCode: 0 });
});
