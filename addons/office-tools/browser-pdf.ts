import { existsSync } from "node:fs";

export interface BrowserCommand {
  name: string;
  command: string;
}

const BROWSER_CANDIDATES = [
  ["Chromium", "chromium"],
  ["Chromium", "chromium-browser"],
  ["Google Chrome", "google-chrome"],
  ["Google Chrome", "google-chrome-stable"],
  ["Microsoft Edge", "microsoft-edge"],
] as const;

export function findBrowserCommand(
  env: NodeJS.ProcessEnv = process.env,
  which: (command: string) => string | null = Bun.which,
): BrowserCommand | null {
  for (const key of ["PICLAW_BROWSER_PATH", "CHROME_PATH", "CHROMIUM_PATH"] as const) {
    const command = env[key]?.trim();
    if (command && existsSync(command)) return { name: key, command };
  }
  for (const [name, candidate] of BROWSER_CANDIDATES) {
    const command = which(candidate);
    if (command) return { name, command };
  }
  return null;
}

export async function printHtmlToPdf(options: {
  outputPath: string;
  url: string;
  signal?: AbortSignal | null;
}): Promise<void> {
  const browser = findBrowserCommand();
  if (!browser) {
    throw new Error("No Chromium browser found. Install Edge, Chrome, or Chromium, or set PICLAW_BROWSER_PATH.");
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new Error("PDF rendering aborted");

  const process = Bun.spawn([
    browser.command,
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--no-sandbox",
    "--no-pdf-header-footer",
    `--print-to-pdf=${options.outputPath}`,
    options.url,
  ], { stdout: "ignore", stderr: "pipe" });

  const abort = () => process.kill();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("PDF rendering aborted");
    if (exitCode !== 0 || !existsSync(options.outputPath)) {
      const detail = stderr.trim();
      throw new Error(`${browser.name} failed to render PDF${detail ? `: ${detail}` : ` (exit ${exitCode})`}`);
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
  }
}
