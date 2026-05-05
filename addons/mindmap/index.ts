/**
 * mindmap/index.ts — Backend route extension for the mindmap addon.
 *
 * Registers /mindmap-vendor/* to serve the D3 mindmap vendor scripts
 * and CSS that the frontend pane needs.
 */

import { resolve, extname, dirname } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";

const EXT_DIR = typeof import.meta.dir === "string"
  ? import.meta.dir
  : dirname(new URL(import.meta.url).pathname);
const VENDOR_DIR = resolve(EXT_DIR, "vendor");
const ROUTE_PREFIX = "/mindmap-vendor";

const MIME_TYPES: Record<string, string> = {
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const HEADERS: Record<string, string> = {
  "X-Frame-Options": "SAMEORIGIN",
  "Cache-Control": "public, max-age=31536000, immutable",
};

function getMimeType(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function handleRoute(req: Request, pathname: string): Response | null {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let relative = pathname.replace(/^\/mindmap-vendor\/?/, "");
  const qIdx = relative.indexOf("?");
  if (qIdx >= 0) relative = relative.substring(0, qIdx);

  if (!relative || relative.includes("..") || relative.startsWith("/")) {
    return new Response("Not Found", { status: 404 });
  }

  const filePath = resolve(VENDOR_DIR, relative);
  let realPath: string;
  try {
    realPath = realpathSync(filePath);
  } catch {
    return new Response("Not Found", { status: 404 });
  }

  if (!existsSync(realPath) || !statSync(realPath).isFile()) {
    return new Response("Not Found", { status: 404 });
  }

  return new Response(Bun.file(realPath), {
    headers: {
      ...HEADERS,
      "Content-Type": getMimeType(realPath),
      "Content-Length": String(statSync(realPath).size),
    },
  });
}

export default function mindmapAddon(_pi: any) {
  const registerRoute = (globalThis as any).__piclaw_registerRoute as
    | ((prefix: string, handler: typeof handleRoute, extensionPath?: string) => "created" | "updated")
    | undefined;

  if (typeof registerRoute === "function") {
    const result = registerRoute(ROUTE_PREFIX, handleRoute, EXT_DIR);
    if (result === "created") {
      console.log("[mindmap] Route registered: /mindmap-vendor/* → " + VENDOR_DIR);
    }
  } else {
    console.warn("[mindmap] WARNING: __piclaw_registerRoute not available.");
  }
}
