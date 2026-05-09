#!/usr/bin/env bun
/**
 * SCRIPT_JDOC:
 * {
 *   "summary": "Export a chat timeline to PDF using the internal localhost export endpoint and wkhtmltopdf.",
 *   "aliases": ["export timeline pdf"],
 *   "domains": ["timeline", "pdf"],
 *   "verbs": ["export"],
 *   "nouns": ["timeline", "pdf"],
 *   "keywords": ["export", "timeline", "pdf", "wkhtmltopdf"],
 *   "guidance": ["Runnable script entrypoint.", "Workspace-owned script surface."],
 *   "examples": ["export timeline pdf"],
 *   "kind": "mixed",
 *   "weight": "heavy",
 *   "role": "entrypoint"
 * }
 */
/**
 * export-timeline-pdf.ts — Internal timeline PDF export.
 *
 * Read-only by design:
 * - never opens SQLite
 * - never writes auth/session state
 * - fetches printable HTML from the localhost internal export endpoint
 * - renders via wkhtmltopdf
 */

import { accessSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "node:child_process";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: bun export-timeline-pdf.ts [options]

Export a chat timeline to a PDF using the internal localhost export endpoint.

Range options (all optional, combinable):
  --from <iso>           Start timestamp (ISO 8601)
  --to <iso>             End timestamp (ISO 8601)
  --from-row <id>        Start message row ID
  --to-row <id>          End message row ID
  --last <n>             Export only the last N messages

Other options:
  --chat <jid>           Chat JID (default: web:default)
  --theme <light|dark>   Color theme (default: light)
  --out <path>           Output PDF path
  --port <n>             Piclaw web server port (default: auto-detect or 8080)
  --auth-key <key>       Internal export auth key (defaults to env/config lookup)
  --html-only            Write HTML sidecar and exit without PDF generation`);
  process.exit(0);
}

const args = process.argv.slice(2);
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(name);
  if (idx >= 0 && idx + 1 < args.length) {
    const value = args[idx + 1];
    if (!value.startsWith("--")) return value;
  }
  return undefined;
};
const hasFlag = (name: string): boolean => args.includes(name);

const chatJid = getArg("--chat") || "web:default";
const fromTs = getArg("--from") || "";
const toTs = getArg("--to") || "";
const fromRow = getArg("--from-row") || "";
const toRow = getArg("--to-row") || "";
const lastN = getArg("--last") || "";
const theme = (getArg("--theme") || "light").toLowerCase();
const outPath = getArg("--out") || `/workspace/exports/timeline-${chatJid.replace(/[^a-z0-9]+/gi, "_")}.pdf`;
const portArg = getArg("--port");
const htmlOnly = hasFlag("--html-only");
const authKeyArg = getArg("--auth-key") || "";

mkdirSync(join(outPath, ".."), { recursive: true });

async function detectPort(): Promise<number> {
  if (portArg) return Number(portArg);
  for (const port of [8080, 3000, 8443]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/manifest.json`, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 302) return port;
    } catch {
      // try next
    }
  }
  return 8080;
}

function loadConfigAuthKey(): string {
  try {
    const config = JSON.parse(readFileSync("/workspace/.piclaw/config.json", "utf8"));
    return String(config?.web?.internalSecret || "").trim();
  } catch {
    return "";
  }
}

function resolveAuthKey(): string {
  return (
    authKeyArg ||
    process.env.PICLAW_EXPORT_AUTH_KEY ||
    process.env.PICLAW_INTERNAL_SECRET ||
    process.env.PICLAW_WEB_INTERNAL_SECRET ||
    loadConfigAuthKey()
  ).trim();
}

function buildExportUrl(port: number): string {
  const params = new URLSearchParams();
  params.set("chat_jid", chatJid);
  params.set("theme", theme);
  if (fromTs) params.set("from", fromTs);
  if (toTs) params.set("to", toTs);
  if (fromRow) params.set("from_row", fromRow);
  if (toRow) params.set("to_row", toRow);
  if (lastN) params.set("last", lastN);
  return `http://127.0.0.1:${port}/internal/export/timeline?${params.toString()}`;
}

async function fetchExportHtml(url: string, authKey: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${authKey}`,
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    throw new Error(`Export endpoint returned ${res.status}`);
  }
  const html = await res.text();
  if (!html.includes('id="export-root"')) {
    throw new Error("Export endpoint returned unexpected HTML");
  }
  if (!html.includes('data-render-done="true"')) {
    throw new Error("Export HTML missing render completion marker");
  }
  return html;
}

function ensureWkhtmltopdf(): string {
  const candidate = spawnSync("bash", ["-lc", "command -v wkhtmltopdf"], { encoding: "utf8" });
  const path = (candidate.stdout || "").trim();
  if (!path) {
    throw new Error("wkhtmltopdf not found in PATH");
  }
  accessSync(path);
  return path;
}

function runWkhtmltopdf(binary: string, url: string, authKey: string, pdfPath: string): void {
  const result = spawnSync(binary, [
    "--print-media-type",
    "--encoding", "utf-8",
    "--load-error-handling", "abort",
    "--load-media-error-handling", "ignore",
    "--custom-header", "Authorization", `Bearer ${authKey}`,
    "--custom-header-propagation",
    url,
    pdfPath,
  ], {
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`wkhtmltopdf failed with exit code ${result.status ?? "unknown"}`);
  }
}

async function run() {
  const authKey = resolveAuthKey();
  if (!authKey) {
    throw new Error("No internal export auth key configured. Pass --auth-key or set web.internalSecret / PICLAW_INTERNAL_SECRET.");
  }

  const port = await detectPort();
  const exportUrl = buildExportUrl(port);
  const htmlPath = outPath.replace(/\.pdf$/i, ".html");

  console.error(`Using server at 127.0.0.1:${port}`);
  console.error(`Export URL: ${exportUrl}`);

  const html = await fetchExportHtml(exportUrl, authKey);
  writeFileSync(htmlPath, html, "utf8");
  console.error(`HTML written: ${htmlPath}`);

  if (htmlOnly) {
    process.stdout.write(htmlPath);
    return;
  }

  const wkhtmltopdf = ensureWkhtmltopdf();
  runWkhtmltopdf(wkhtmltopdf, exportUrl, authKey, outPath);

  if (!existsSync(outPath)) {
    throw new Error("wkhtmltopdf did not create the PDF output");
  }
  const size = statSync(outPath).size;
  if (size < 1500) {
    throw new Error(`Generated PDF is unexpectedly small (${size} bytes)`);
  }

  console.error(`PDF written: ${outPath}`);
  process.stdout.write(outPath);
}

run().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
