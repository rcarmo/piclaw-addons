import { afterEach, expect, test } from "bun:test";

import { spawnManagedPty, type ManagedPty } from "./pty-backend.ts";

const children: ManagedPty[] = [];
afterEach(() => {
	for (const child of children.splice(0)) child.dispose();
});

function shellCommand(command: string): { file: string; args: string[] } {
	if (process.platform === "win32") {
		return { file: "pwsh", args: ["-NoLogo", "-NoProfile", "-Command", command] };
	}
	return { file: "/bin/bash", args: ["-lc", command] };
}

async function runPty(command: string, options: {
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
		onData: (data) => { output += data; },
		onExit: resolveExit,
	});
	children.push(child);
	await options.interact?.(child);
	const exitCode = await Promise.race([
		exited,
		Bun.sleep(10_000).then(() => { throw new Error(`PTY command timed out: ${command}`); }),
	]);
	selectedBackend = child.backend;
	return { child, output, exitCode, selectedBackend };
}

test("Bun PTY exposes 80x24 dimensions and a controlling foreground terminal on POSIX", async () => {
	if (process.platform === "win32") return;
	const command = process.platform === "linux"
		? "printf 'tty=%s size=%s ids=%s' \"$(test -t 0 && echo yes || echo no)\" \"$(stty size)\" \"$(ps -p $$ -o sid=,pgid=,tpgid= | tr -s ' ')\""
		: "printf 'tty=%s size=%s' \"$(test -t 0 && echo yes || echo no)\" \"$(stty size)\"";
	const result = await runPty(command);
	expect(result.output).toContain("tty=yes size=24 80");
	if (process.platform === "linux") {
		const match = result.output.match(/ids=\s*(\d+)\s+(\d+)\s+(\d+)/);
		expect(match).not.toBeNull();
		expect(match?.[1]).toBe(match?.[2]);
		expect(match?.[2]).toBe(match?.[3]);
	}
	expect(result.exitCode).toBe(0);
});

test("Bun PTY supports interactive input and resize", async () => {
	const command = process.platform === "win32"
		? `$value = [Console]::In.ReadLine(); [Console]::Write("input=$value")`
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
	const result = await runPty("exit 7");
	expect(result.exitCode).toBe(7);
	expect(result.selectedBackend).toBe("bun");
});

test("Bun PTY kill terminates the process tree without leaking background work", async () => {
	let output = "";
	let resolveExit!: (code: number) => void;
	const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
	const command = process.platform === "win32"
		? `$child = Start-Process -PassThru -WindowStyle Hidden pwsh -ArgumentList '-NoLogo','-NoProfile','-Command','Start-Sleep -Seconds 60'; [Console]::WriteLine("ready child=$($child.Id)"); Start-Sleep -Seconds 60`
		: "sleep 60 & bg=$!; printf 'shell=%s bg=%s\\n' $$ $bg; wait";
	const { file, args } = shellCommand(command);
	const child = await spawnManagedPty(file, args, {
		cwd: process.cwd(), env: process.env, name: "xterm-256color", cols: 80, rows: 24,
		onData: (data) => { output += data; }, onExit: resolveExit,
	});
	children.push(child);
	const readyPattern = process.platform === "win32" ? /ready child=(\d+)/i : /shell=(\d+) bg=(\d+)/;
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
	const backgroundPid = Number(process.platform === "win32" ? match?.[1] : match?.[2]);
	expect(alive(backgroundPid)).toBe(false);
});
