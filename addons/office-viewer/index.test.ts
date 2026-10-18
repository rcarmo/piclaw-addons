import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import officeViewer from "./index.ts";

import { officeViewerPaneExtension } from "./web/office-viewer-pane.js";

test("office viewer uses its standalone pane contract", () => {
  expect(officeViewerPaneExtension.canHandle?.({ path: "report.docx", mode: "view" })).toBe(50);
  expect(officeViewerPaneExtension.canHandle?.({ path: "report.pdf", mode: "view" })).toBeFalse();
  expect(officeViewerPaneExtension.capabilities).toEqual(["readonly", "preview"]);
});

test("office viewer route containment rejects escaped symlinks and preserves assets", async () => {
  const vendor = join(import.meta.dir, "vendor");
  const fixture = mkdtempSync(join(vendor, "route-containment-"));
  const outside = mkdtempSync(join(tmpdir(), "office-viewer-outside-"));
  const globals = globalThis as any;
  const names = ["__piclaw_registerRoute", "__piclaw_registerToolStatusHintProvider"];
  const descriptors = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  let handler!: (request: Request, pathname: string) => Response;
  try {
    Object.defineProperty(globals, names[0]!, {
      configurable: true,
      value: (prefix: string, registered: typeof handler, extensionPath: string) => {
        expect(prefix).toBe("/office-viewer");
        expect(realpathSync(extensionPath)).toBe(realpathSync(import.meta.dir));
        handler = registered;
        return "updated";
      },
    });
    Object.defineProperty(globals, names[1]!, { configurable: true, value: () => {} });
    officeViewer({ registerTool() {} });

    writeFileSync(join(outside, "secret.js"), "SECRET_OUTSIDE_VENDOR");
    writeFileSync(join(fixture, "asset.js"), "/* contained asset */");
    symlinkSync(join(outside, "secret.js"), join(fixture, "symlink-file.js"));
    symlinkSync(join(fixture, "asset.js"), join(fixture, "contained-link.js"));
    const prefix = `/office-viewer/${fixture.split("/").pop()}`;
    const request = (path: string, method = "GET") => handler(
      new Request(`http://localhost${path}`, { method }), path,
    );

    for (const method of ["GET", "HEAD"]) {
      const escaped = request(`${prefix}/symlink-file.js`, method);
      expect(escaped.status).toBe(403);
      expect(await escaped.text()).not.toContain("SECRET_OUTSIDE_VENDOR");
      for (const asset of ["asset.js", "contained-link.js"]) {
        const response = request(`${prefix}/${asset}`, method);
        expect(response.status).toBe(200);
        expect(response.headers.get("Content-Type")).toBe("application/javascript; charset=utf-8");
        expect(response.headers.get("Content-Length")).toBe(String("/* contained asset */".length));
        expect(response.headers.get("Cache-Control")).toBe("no-cache");
        expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
        expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
        if (method === "GET") expect(await response.text()).toBe("/* contained asset */");
      }
    }
    expect(request(`${prefix}/missing.js`).status).toBe(404);
    expect(request(`${prefix}/../secret.js`).status).toBe(403);
  } finally {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globals, name, descriptor);
      else delete globals[name];
    });
    rmSync(fixture, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
