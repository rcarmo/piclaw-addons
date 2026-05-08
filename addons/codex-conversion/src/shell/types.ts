export type ShellAction =
	| { kind: "read"; command: string; name: string; path: string }
	| { kind: "list"; command: string; path?: string }
	| { kind: "search"; command: string; query?: string; path?: string }
	| { kind: "run"; command: string };

export interface CommandSummary {
	maskAsExplored: boolean;
	actions: ShellAction[];
}
