export const CODEX_FALLBACK_SHELL = process.platform === "win32"
	? (process.env.ComSpec || "cmd.exe")
	: "/bin/bash";

export function isWindowsCommandShell(shell: string): boolean {
	const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "cmd" || name === "cmd.exe";
}

export function isPowerShell(shell: string): boolean {
	const name = shell.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe";
}

export function isFishShell(shell: string | undefined): boolean {
	const name = shell?.replace(/\\/g, "/").split("/").pop()?.toLowerCase();
	return name === "fish";
}

export function getCodexRuntimeShell(shell: string | undefined): string {
	if (!shell) {
		return CODEX_FALLBACK_SHELL;
	}
	return isFishShell(shell) ? CODEX_FALLBACK_SHELL : shell;
}
