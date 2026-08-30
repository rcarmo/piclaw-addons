import type { IPty } from "node-pty";

export type PtyBackendName = "bun" | "node-pty";
export type PtyBackendPreference = "auto" | PtyBackendName;

export interface ManagedPty {
	readonly backend: PtyBackendName;
	readonly pid?: number;
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
	backend?: PtyBackendPreference;
	onData(data: string): void;
	onExit(exitCode: number): void;
	onBackend?(backend: PtyBackendName): void;
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
	if (process.platform === "win32") {
		try {
			Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], {
				stdin: "ignore",
				stdout: "ignore",
				stderr: "ignore",
			});
			return;
		} catch {
			process.kill(pid, signal);
			return;
		}
	}

	try {
		process.kill(-pid, signal);
	} catch {
		process.kill(pid, signal);
	}
}

function spawnBunPty(file: string, args: string[], options: ManagedPtySpawnOptions): ManagedPty {
	if (typeof Bun.Terminal !== "function") throw new Error("Bun.Terminal is unavailable");

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
			// controlling terminal. Windows: ConPTY already owns the console tree.
			detached: process.platform !== "win32",
		});
		child = spawnedChild;
		options.onBackend?.("bun");
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
				if (settled) return;
				signalProcessTree(spawnedChild.pid, signal);
			},
			dispose() {
				if (!settled) signalProcessTree(spawnedChild.pid, "SIGTERM");
				terminal.close();
			},
		};
	} catch (error) {
		terminal.close();
		throw error;
	}
}

async function spawnNodePty(file: string, args: string[], options: ManagedPtySpawnOptions): Promise<ManagedPty> {
	const pty = await import("node-pty");
	const child: IPty = pty.spawn(file, args, {
		cwd: options.cwd,
		env: options.env,
		name: options.name,
		cols: options.cols,
		rows: options.rows,
	});
	let settled = false;
	let dataSubscription: { dispose(): void } | null = null;
	let exitSubscription: { dispose(): void } | null = null;
	const releaseSubscriptions = () => {
		dataSubscription?.dispose();
		exitSubscription?.dispose();
		dataSubscription = null;
		exitSubscription = null;
	};
	dataSubscription = child.onData(options.onData);
	exitSubscription = child.onExit(({ exitCode }) => {
		void (async () => {
			await Bun.sleep(25);
			if (settled) return;
			settled = true;
			releaseSubscriptions();
			options.onExit(exitCode ?? 0);
		})();
	});
	options.onBackend?.("node-pty");
	return {
		backend: "node-pty",
		pid: child.pid,
		write(data) { child.write(data); },
		resize(cols, rows) { child.resize(cols, rows); },
		kill(signal) { child.kill(signal); },
		dispose() {
			if (settled) return;
			settled = true;
			releaseSubscriptions();
			child.kill();
		},
	};
}

export async function spawnManagedPty(
	file: string,
	args: string[],
	options: ManagedPtySpawnOptions,
): Promise<ManagedPty> {
	let bunError: unknown;
	if (options.backend !== "node-pty") {
		try {
			return spawnBunPty(file, args, options);
		} catch (error) {
			if (options.backend === "bun") throw error;
			bunError = error;
		}
	}
	try {
		return await spawnNodePty(file, args, options);
	} catch (error) {
		if (bunError === undefined) throw error;
		throw new AggregateError([bunError, error], "Bun.Terminal and node-pty both failed to start the PTY session");
	}
}
