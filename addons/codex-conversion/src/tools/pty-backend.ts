export interface ManagedPty {
	readonly backend: "bun";
	readonly pid: number;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	kill(signal?: NodeJS.Signals): void;
	dispose(): void;
}

export interface ManagedPtySpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	name: string;
	cols: number;
	rows: number;
	onData(data: string): void;
	onExit(exitCode: number): void;
}

function terminateProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		return;
	}

	try {
		process.kill(-pid, signal);
	} catch {
		process.kill(pid, signal);
	}
}

export function spawnManagedPty(
	file: string,
	args: string[],
	options: ManagedPtySpawnOptions,
): ManagedPty {
	if (typeof Bun.Terminal !== "function") throw new Error("Bun.Terminal is unavailable; codex-conversion requires Bun 1.4 or newer");

	let settled = false;
	let child: Bun.Subprocess | null = null;
	const decoder = new TextDecoder();
	const finish = async () => {
		if (settled || !child) return;
		settled = true;
		const exitCode = await child.exited;
		const trailing = decoder.decode();
		if (trailing) options.onData(trailing);
		terminal.close();
		options.onExit(exitCode);
	};
	const terminal = new Bun.Terminal({
		cols: options.cols,
		rows: options.rows,
		name: options.name,
		data(_terminal, data) {
			options.onData(decoder.decode(data, { stream: true }));
		},
		exit() { void finish(); },
	});

	try {
		const spawnedChild = Bun.spawn([file, ...args], {
			cwd: options.cwd,
			env: options.env,
			terminal,
			// POSIX: creates a new session/process group and makes the PTY the
			// controlling terminal. Windows: ConPTY owns the console tree.
			detached: process.platform !== "win32",
		});
		child = spawnedChild;
		// Terminal EOF is the authoritative output-drained boundary. Keep a
		// bounded fallback for runtimes that settle the process without an EOF callback.
		void spawnedChild.exited.then(async () => {
			await Bun.sleep(25);
			await finish();
		});
		return {
			backend: "bun",
			pid: spawnedChild.pid,
			write(data) { terminal.write(data); },
			resize(cols, rows) { terminal.resize(cols, rows); },
			kill(signal = "SIGTERM") {
				if (!settled) terminateProcessTree(spawnedChild.pid, signal);
			},
			dispose() {
				if (!settled) terminateProcessTree(spawnedChild.pid, "SIGTERM");
				terminal.close();
			},
		};
	} catch (error) {
		terminal.close();
		throw error;
	}
}
