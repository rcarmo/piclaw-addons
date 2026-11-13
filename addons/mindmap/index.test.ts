import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import mindmapAddon from "./index.ts";

function registeredRoute() {
  const globals = globalThis as any;
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__piclaw_registerRoute");
  let handler!: (request: Request, pathname: string) => Response | null;
  Object.defineProperty(globals, "__piclaw_registerRoute", {
    configurable: true,
    value: (prefix: string, registered: typeof handler, extensionPath: string) => {
      expect(prefix).toBe("/mindmap-vendor");
      expect(realpathSync(extensionPath)).toBe(realpathSync(import.meta.dir));
      handler = registered;
      return "updated";
    },
  });
  try { mindmapAddon({}); } finally {
    if (descriptor) Object.defineProperty(globals, "__piclaw_registerRoute", descriptor);
    else delete globals.__piclaw_registerRoute;
  }
  return (path: string, method = "GET") => handler(new Request(`http://localhost${path}`, { method }), path)!;
}

test("mindmap route serves every vendor asset the pane loads with executable MIME types", async () => {
  const request = registeredRoute();
  const assets = {
    "mindmap-editor.js": "application/javascript; charset=utf-8",
    "d3-mindmap.min.js": "application/javascript; charset=utf-8",
    "js-yaml.min.js": "application/javascript; charset=utf-8",
    "mindmap.css": "text/css; charset=utf-8",
  };
  for (const [asset, type] of Object.entries(assets)) {
    const bytes = readFileSync(join(import.meta.dir, "vendor", asset));
    for (const method of ["GET", "HEAD"]) {
      const response = request(`/mindmap-vendor/${asset}?v=cache-bust`, method);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("Content-Length")).toBe(String(bytes.length));
      if (method === "GET") expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    }
  }
});

test("mindmap route rejects methods, missing files, traversal and escaped symlinks", async () => {
  const vendor = join(import.meta.dir, "vendor");
  const fixture = mkdtempSync(join(vendor, "route-containment-"));
  const outside = mkdtempSync(join(tmpdir(), "mindmap-outside-"));
  try {
    const request = registeredRoute();
    writeFileSync(join(outside, "secret.js"), "SECRET_OUTSIDE_VENDOR");
    symlinkSync(join(outside, "secret.js"), join(fixture, "escaped.js"));
    const prefix = `/mindmap-vendor/${fixture.split("/").pop()}`;
    expect(request("/mindmap-vendor/mindmap.css", "POST").status).toBe(405);
    expect(request("/mindmap-vendor/missing.js").status).toBe(404);
    expect(request("/mindmap-vendor/").status).toBe(404);
    expect(request("/mindmap-vendor/../index.ts").status).toBe(404);
    const escaped = request(`${prefix}/escaped.js`);
    expect(escaped.status).toBe(404);
    expect(await escaped.text()).not.toContain("SECRET_OUTSIDE_VENDOR");
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
