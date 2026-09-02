import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import drawioEditor, {
  DRAWIO_VERSION,
  MINIMAL_DRAWIO_EXPORT_ACTIONS,
  MINIMAL_DRAWIO_FILE_MENU_ACTIONS,
  buildEmbeddedDrawioAppUrl,
  getDrawioVendorDirCandidates,
  handleRoute,
  isBinaryDrawioSaveTarget,
  isExplicitDrawioExportRequest,
  isTrustedDrawioMessageEvent,
  resolveDrawioSavePath,
  resolveDrawioVendorDir,
} from "./index";

const addonDir = dirname(fileURLToPath(import.meta.url));
const packageManifest = JSON.parse(readFileSync(join(addonDir, "package.json"), "utf8"));
const vendorMetadata = JSON.parse(readFileSync(join(addonDir, "vendor", "drawio.meta.json"), "utf8"));
const appSource = readFileSync(join(addonDir, "vendor", "js", "app.min.js"), "utf8");
const roots: string[] = [];

function tempWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "piclaw-drawio-test-"));
  roots.push(root);
  return root;
}

async function save(workspace: string, payload: Record<string, unknown>): Promise<Response> {
  const previous = process.env.PICLAW_WORKSPACE;
  process.env.PICLAW_WORKSPACE = workspace;
  try {
    return await handleRoute(new Request("http://localhost/drawio/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }), "/drawio/save") as Response;
  } finally {
    if (previous === undefined) delete process.env.PICLAW_WORKSPACE;
    else process.env.PICLAW_WORKSPACE = previous;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("draw.io 31.4.2 vendor integrity", () => {
  test("aligns add-on, metadata, runtime and bundled JavaScript versions", () => {
    expect(packageManifest.version).toBe("31.4.2");
    expect(DRAWIO_VERSION).toBe("v31.4.2");
    expect(vendorMetadata.package_version).toBe(DRAWIO_VERSION);
    expect(vendorMetadata.source_url).toBe("https://github.com/jgraph/drawio/releases/download/v31.4.2/draw.war");
    expect(vendorMetadata.source_sha256).toBe("cfc35c3da0ad40f7b16f163e60eaef75b267919a97f939f6bf2f6f2ee608239b");
    expect(vendorMetadata.output_dir).toBe("addons/drawio-editor/vendor");
    expect(vendorMetadata.metadata_file).toBe("addons/drawio-editor/vendor/drawio.meta.json");
    expect(appSource).toContain('mxClient={VERSION:"31.4.2"');
    expect(appSource).toContain('EditorUi.VERSION="31.4.2"');
  });

  test("ships the complete self-hosted client subset and no misleading postinstall", () => {
    for (const path of [
      "index.html", "favicon.ico", "js/app.min.js", "js/PreConfig.js", "js/PostConfig.js",
      "styles/grapheditor.css", "mxgraph/mxClient.js", "resources/dia.txt", "math4/es5/startup.js",
    ]) expect(statSync(join(addonDir, "vendor", path)).isFile(), path).toBe(true);
    expect(packageManifest.scripts.postinstall).toBeUndefined();
    expect(packageManifest.scripts["vendor:update"]).toBe("bun run scripts/vendor-drawio.ts");
  });
});

describe("draw.io wrapper and route contract", () => {
  test("uses the vendored add-on first and version-aligned fallback paths", () => {
    const candidates = getDrawioVendorDirCandidates("/addon", "/workspace");
    expect(candidates).toEqual([
      resolve("/addon", "vendor"),
      resolve("/workspace", "runtime/extensions/viewers/drawio-editor/vendor"),
      resolve("/workspace", "piclaw/runtime/extensions/viewers/drawio-editor/vendor"),
      resolve("/workspace", "generated/cache/vendor/drawio", "v31.4.2"),
      resolve("/workspace", "piclaw/generated/cache/vendor/drawio", "v31.4.2"),
    ]);
    expect(resolveDrawioVendorDir(addonDir, "/missing")).toBe(resolve(addonDir, "vendor"));
  });

  test("keeps embedded controls, reduced menus and trusted message checks", async () => {
    expect(buildEmbeddedDrawioAppUrl(true)).toContain("/drawio/index.html?embed=1&proto=json");
    expect(buildEmbeddedDrawioAppUrl(true)).toContain("noSaveBtn=1");
    expect(buildEmbeddedDrawioAppUrl(true)).toContain("noExitBtn=1");
    expect(buildEmbeddedDrawioAppUrl(true)).toContain("libraries=0");
    expect(buildEmbeddedDrawioAppUrl(false, true)).toContain("chrome=0");
    expect(MINIMAL_DRAWIO_FILE_MENU_ACTIONS).toEqual(["save", "-"]);
    expect(MINIMAL_DRAWIO_EXPORT_ACTIONS).toEqual(["exportPng", "exportJpg", "exportSvg"]);
    const frame = {};
    expect(isTrustedDrawioMessageEvent("https://piclaw.test", "https://piclaw.test", frame, frame)).toBe(true);
    expect(isTrustedDrawioMessageEvent("https://evil.test", "https://piclaw.test", frame, frame)).toBe(false);
    expect(isTrustedDrawioMessageEvent("https://piclaw.test", "https://piclaw.test", {}, frame)).toBe(false);

    const wrapper = await handleRoute(new Request("http://localhost/drawio/edit?path=test.drawio"), "/drawio/edit") as Response;
    const html = await wrapper.text();
    expect(wrapper.status).toBe(200);
    expect(wrapper.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(wrapper.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
    expect(html).toContain("patchDrawioExportTarget");
    expect(html).toContain("patchExportPrototype(win && win.EditorUi)");
    expect(html).toContain("patchExportPrototype(win && win.App)");
    expect(html).toContain("saveWorkspace(payload, true)");
    expect(html).not.toContain("Object.assign({ event: 'workspace-export' }, payload)");
    expect(html).toContain('case \'autosave\'');
    expect(html).toContain('case \'save\'');
    expect(html).toContain('case \'workspace-export\'');
    expect(html).toContain('["save","-"]');
    expect(html).toContain('["exportPng","exportJpg","exportSvg"]');
  });

  test("serves versioned vendor assets with embed CSP", async () => {
    const response = await handleRoute(new Request("http://localhost/drawio/js/app.min.js"), "/drawio/js/app.min.js") as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
    expect(response.headers.get("content-security-policy")).toContain("connect-src 'self'");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(1_000_000);
  });
});

describe("draw.io save and export persistence", () => {
  test("preserves the source path for ordinary XML saves", async () => {
    const workspace = tempWorkspace();
    const xml = '<mxfile><diagram name="Saved"><mxGraphModel/></diagram></mxfile>';
    const response = await save(workspace, { path: "diagrams/main.drawio", format: "xml", xml });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, path: "diagrams/main.drawio" });
    expect(readFileSync(join(workspace, "diagrams", "main.drawio"), "utf8")).toBe(xml);
  });

  test("writes PNG, JPG and SVG exports to deterministic sibling paths", async () => {
    const workspace = tempWorkspace();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>saved</text></svg>';
    const cases = [
      { mimeType: "image/png", filename: "main.png", data: `data:image/png;base64,${png.toString("base64")}`, path: "diagrams/main.png", bytes: png },
      { mimeType: "image/jpeg", filename: "main.jpg", data: jpg.toString("base64"), base64Encoded: true, path: "diagrams/main.jpg", bytes: jpg },
      { mimeType: "image/svg+xml", filename: "main.svg", data: `data:image/svg+xml,${encodeURIComponent(svg)}`, path: "diagrams/main.svg", text: svg },
    ];
    for (const item of cases) {
      const response = await save(workspace, { path: "diagrams/main.drawio", ...item });
      expect(response.status).toBe(200);
      expect((await response.json()).path).toBe(item.path);
      if (item.bytes) expect(Buffer.from(readFileSync(join(workspace, item.path)))).toEqual(item.bytes);
      else expect(readFileSync(join(workspace, item.path), "utf8")).toBe(item.text!);
    }
  });

  test("classifies explicit export and binary targets consistently", () => {
    expect(isExplicitDrawioExportRequest(undefined, "diagram.drawio")).toBe(false);
    expect(isExplicitDrawioExportRequest("image/png", "diagram.png")).toBe(true);
    expect(resolveDrawioSavePath("diagram.drawio", "image/jpeg", "diagram.jpg")).toBe("diagram.jpg");
    expect(resolveDrawioSavePath("diagram.drawio.png", "image/svg+xml", "diagram.svg")).toBe("diagram.svg");
    expect(isBinaryDrawioSaveTarget("diagram.png", undefined, "image/png")).toBe(true);
    expect(isBinaryDrawioSaveTarget("diagram.jpg", "jpeg", "image/jpeg")).toBe(true);
    expect(isBinaryDrawioSaveTarget("diagram.svg", "xmlsvg", "image/svg+xml")).toBe(false);
  });

  test("rejects workspace escapes and missing export data", async () => {
    const workspace = tempWorkspace();
    expect((await save(workspace, { path: "../outside.drawio", xml: "x" })).status).toBe(400);
    expect((await save(workspace, { path: "main.drawio", mimeType: "image/png", filename: "main.png" })).status).toBe(400);
  });
});

describe("draw.io tool integration", () => {
  test("creates a new diagram and opens the Piclaw pane", async () => {
    const workspace = tempWorkspace();
    const previous = process.env.PICLAW_WORKSPACE;
    process.env.PICLAW_WORKSPACE = workspace;
    const tools = new Map<string, any>();
    const paneCalls: unknown[] = [];
    try {
      drawioEditor({ registerTool(tool: any) { tools.set(tool.name, tool); } } as any);
      const tool = tools.get("open_drawio_editor");
      expect(tool).toBeDefined();
      const result = await tool.execute("call", { path: "diagrams/new.drawio" }, undefined, undefined, {
        hasUI: true,
        ui: { custom(_component: unknown, payload: unknown) { paneCalls.push(payload); return { ok: true, opened: true, target: "tab" }; } },
      });
      expect(statSync(join(workspace, "diagrams", "new.drawio")).isFile()).toBe(true);
      expect(readFileSync(join(workspace, "diagrams", "new.drawio"), "utf8")).toContain("<mxfile");
      expect(paneCalls).toEqual([{ timeout: 15000, action: "open_workspace_file", path: "diagrams/new.drawio", label: "new.drawio", target: "tab" }]);
      expect(result.details).toMatchObject({ ok: true, opened: true, path: "diagrams/new.drawio", target: "tab" });
      expect(result.content[0].text).toContain("Opened diagrams/new.drawio");

      const fallback = await tool.execute("call", { path: "diagrams/fallback.drawio" }, undefined, undefined, {
        hasUI: true,
        ui: { custom() { return { ok: false, opened: false, reason: "not_supported", detail: "Pane unavailable." }; } },
      });
      expect(fallback.details).toMatchObject({ ok: false, opened: false, reason: "not_supported", editorUrl: "/drawio/edit?path=diagrams%2Ffallback.drawio" });
      expect(fallback.content[0].text).toContain("Fallback URL");
    } finally {
      if (previous === undefined) delete process.env.PICLAW_WORKSPACE;
      else process.env.PICLAW_WORKSPACE = previous;
    }
  });
});
