import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const DRAWIO_EXTENSIONS = [".drawio", ".drawio.xml", ".drawio.svg", ".drawio.png"];
export const DEFAULT_DRAWIO_XML = '<mxfile host="app.diagrams.net"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1260" dy="720" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

export function normalizeWorkspaceRelativePath(input: string): string {
  const trimmed = String(input || "").trim().replace(/^@/, "").replace(/\\+/g, "/");
  if (!trimmed) throw new Error("Missing path");
  const stripped = trimmed.replace(/^\/workspace\//, "").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const segment of stripped.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!parts.length) throw new Error("Forbidden path");
      parts.pop();
    } else parts.push(segment);
  }
  if (!parts.length) throw new Error("Missing path");
  return parts.join("/");
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

/** Check the closest existing ancestor, including dangling symlinks. */
export function resolveWorkspacePath(path: string, workspaceRoot: string): string {
  const root = realpathSync(workspaceRoot);
  const full = resolve(root, normalizeWorkspaceRelativePath(path));
  if (!inside(root, full)) throw new Error("Forbidden path");
  let ancestor = full;
  for (;;) {
    try { lstatSync(ancestor); break; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (!inside(root, realpathSync(ancestor))) throw new Error("Forbidden path");
  return full;
}

type OpenOutcome = { ok?: boolean; opened?: boolean; target?: string; detail?: string; reason?: string } | undefined;
export interface DrawioToolAuthority {
  assertCurrent(): void;
  openWorkspaceFile?(path: string): Promise<OpenOutcome> | OpenOutcome;
}
export interface DrawioToolOptions {
  /** Explicit native workspace; never changes process cwd. */
  cwd: string;
  authority: DrawioToolAuthority;
}

/** Side-effect-free import/factory. No route registration or vendor extraction.
 * Legacy and native hosts execute this same body; native supplies only ports.
 * Exclusive creation prevents a replay/race from resetting an existing document.
 * Filesystem changes are not transactional or claimed exactly-once.
 */
export function createDrawioEditorTool(options?: DrawioToolOptions) {
  const canonicalRoot = options ? realpathSync(options.cwd) : undefined;
  const native = options !== undefined;
  const authority = options?.authority;
  const assertCurrent = authority?.assertCurrent.bind(authority);
  const openWorkspaceFile = authority?.openWorkspaceFile?.bind(authority);
  return {
    name: "open_drawio_editor",
    label: "Open Draw.io Editor",
    description: "Open or create a .drawio diagram file in the web UI draw.io pane when available. Returns a fallback URL when direct pane opening is unavailable.",
    promptSnippet: "open_drawio_editor: open/create a draw.io file in the web UI draw.io pane.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Workspace path to the .drawio file (created if it doesn't exist)." } }, required: ["path"] },
    async execute(_toolCallId: string, params: { path: string }, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: any) {
      const check = () => { _signal?.throwIfAborted(); assertCurrent?.(); };
      check();
      const root = canonicalRoot ?? realpathSync(process.env.PICLAW_WORKSPACE || "/workspace");
      const filePath = normalizeWorkspaceRelativePath(params.path || "");
      if (!DRAWIO_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext)) && !filePath.toLowerCase().endsWith(".xml")) {
        throw new Error(`Unsupported file type. Expected: ${DRAWIO_EXTENSIONS.join(", ")} or .xml`);
      }
      const absolutePath = resolveWorkspacePath(filePath, root);
      if (!existsSync(absolutePath)) {
        // Resolve and fence every individual mkdir, not just recursive mkdir's start.
        const missing: string[] = [];
        let parent = dirname(absolutePath);
        while (!existsSync(parent)) { missing.unshift(parent); parent = dirname(parent); }
        for (const directory of missing) {
          resolveWorkspacePath(relative(root, directory), root);
          check();
          try { mkdirSync(directory); } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          }
          resolveWorkspacePath(relative(root, directory), root);
          if (!statSync(directory).isDirectory()) throw new Error("Not a directory");
        }
        resolveWorkspacePath(filePath, root);
        check();
        let fd: number | undefined;
        try { fd = openSync(absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o666); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (fd !== undefined) {
          try {
            if (!fstatSync(fd).isFile()) throw new Error(`Not a file: ${filePath}`);
            check();
            writeFileSync(fd, DEFAULT_DRAWIO_XML, "utf8");
            check();
          } finally { closeSync(fd); }
        }
      }
      resolveWorkspacePath(filePath, root);
      if (!statSync(absolutePath).isFile()) throw new Error(`Not a file: ${filePath}`);
      check();
      const editorUrl = `/drawio/edit?path=${encodeURIComponent(filePath)}`;
      const label = filePath.split("/").pop() || "diagram.drawio";
      const opener = native ? openWorkspaceFile : ctx?.hasUI && typeof ctx?.ui?.custom === "function"
        ? (path: string) => ctx.ui.custom(() => null, { timeout: 15000, action: "open_workspace_file", path, label, target: "tab" })
        : undefined;
      if (opener) {
        let outcome: OpenOutcome;
        let failure: string | undefined;
        check();
        try { outcome = await opener(filePath); }
        catch (error) { failure = error instanceof Error ? error.message : String(error || "Unknown UI error"); }
        // Revocation after UI await must fail, not be translated into a fallback success.
        check();
        if (failure !== undefined) return {
          content: [{ type: "text" as const, text: `Could not open the Draw.io pane directly.\n\nFallback URL: ${editorUrl}\n\nReason: ${failure}` }],
          details: { ok: false, opened: false, reason: "ui_open_failed", path: filePath, target: "tab", editorUrl },
        };
        if (outcome?.ok !== false && outcome?.opened !== false) return {
          content: [{ type: "text" as const, text: `Opened ${filePath} in the Draw.io editor pane.` }],
          details: { ok: true, opened: true, path: filePath, target: outcome?.target || "tab", editorUrl },
        };
        const detail = typeof outcome?.detail === "string" && outcome.detail.trim() ? outcome.detail.trim() : "The web UI did not open the Draw.io pane directly.";
        return {
          content: [{ type: "text" as const, text: `${detail}\n\nFallback URL: ${editorUrl}` }],
          details: { ok: false, opened: false, reason: outcome?.reason || "ui_open_failed", path: filePath, target: "tab", editorUrl },
        };
      }
      return {
        content: [{ type: "text" as const, text: `Draw.io editor URL: ${editorUrl}\n\nOpen this URL in the browser to edit the diagram. Changes are auto-saved to the workspace.` }],
        details: { editorUrl, path: filePath },
      };
    },
  };
}
