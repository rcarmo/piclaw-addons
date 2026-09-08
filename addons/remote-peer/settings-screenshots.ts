import { copyFile, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { PeerService } from "./service.js";

if (process.env.PICLAW_E2E_DISPOSABLE !== "1")
  throw new Error(
    "Set PICLAW_E2E_DISPOSABLE=1 for the owned screenshot fixture.",
  );
const executablePath = process.env.PICLAW_E2E_BROWSER,
  output = process.env.PICLAW_E2E_SCREENSHOT_DIR;
if (!executablePath || !output)
  throw new Error(
    "Set PICLAW_E2E_BROWSER and explicit PICLAW_E2E_SCREENSHOT_DIR.",
  );
const outputDir = resolve(output);
if (!outputDir.endsWith("/addons/remote-peer/assets"))
  throw new Error(
    "Screenshot output must be the Remote Peer assets directory.",
  );
await mkdir(outputDir, { recursive: true });
if ((await realpath(outputDir)) !== outputDir)
  throw new Error("Screenshot output directory must not use symlinks.");
const freshOutput = join(outputDir, "settings-fresh.png");
const pairedOutput = join(outputDir, "settings-paired.png");
const require = createRequire(import.meta.url),
  root = await mkdtemp(join(tmpdir(), "iroh-settings-shot-"));
const runtime = (agents: Array<{ agent_name: string; active: boolean }> = []) =>
  ({
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => agents,
      deliverPeerMessage: async () => ({
        status: "ok",
        row_id: 1,
        created: true,
      }),
    },
  }) as any;
let browser: any,
  server: any,
  a: PeerService | undefined,
  b: PeerService | undefined;
try {
  for (const dir of ["home", "tmp", "bundle"]) await mkdir(join(root, dir));
  a = new PeerService({
    dataDir: join(root, "a"),
    bindAddr: "127.0.0.1:0",
    runtime: runtime([{ agent_name: "research", active: true }]),
  });
  b = new PeerService({
    dataDir: join(root, "b"),
    bindAddr: "127.0.0.1:0",
    runtime: runtime([{ agent_name: "research", active: true }]),
  });
  const shim = join(root, "entry.js");
  await Bun.write(
    shim,
    `import * as preact from ${JSON.stringify(require.resolve("preact").replace("preact.js", "preact.module.js"))};import * as hooks from ${JSON.stringify(require.resolve("preact/hooks").replace("hooks.js", "hooks.module.js"))};import htm from ${JSON.stringify(require.resolve("htm"))};globalThis.__piclawPreactHtm={html:htm.bind(preact.h),...hooks};globalThis.__piclawSettingsPaneRegistry={registerSettingsPane:({component})=>preact.render(preact.h(component),document.getElementById('app')),notifySettingsPanesChanged:()=>{}};await import(${JSON.stringify(join(import.meta.dir, "web/index.ts"))});`,
  );
  const built = await Bun.build({
    entrypoints: [shim],
    outdir: join(root, "bundle"),
    target: "browser",
    splitting: false,
  });
  if (!built.success) throw new Error(String(built.logs));
  const js = await built.outputs[0].text();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(
          `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:dark;--bg-primary:#111827;--bg-secondary:#172131;--text-primary:#e5edf5;--text-secondary:#9aa8b7;--border-color:#334155;--accent-color:#5eead4;--danger-color:#f87171}body{margin:0;background:#0d1117;color:var(--text-primary);font:14px system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{max-width:980px;margin:auto;padding:24px}button,select,input,textarea{font:inherit;color:inherit;background:#172131;border:1px solid #475569;border-radius:6px;padding:6px 10px}code{color:#a7f3d0}</style></head><body><main><div id="app"></div></main><script type="module" src="/ui.js"></script></body></html>`,
          { headers: { "Content-Type": "text/html" } },
        );
      if (path === "/ui.js")
        return new Response(js, {
          headers: { "Content-Type": "text/javascript" },
        });
      try {
        if (path.endsWith("/dashboard"))
          return Response.json(await a!.dashboard());
        if (path.endsWith("/config"))
          return Response.json({
            config:
              req.method === "POST"
                ? await a!.configure((await req.json()) as any)
                : a!.state.config(),
            identity: a!.identity(),
          });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      return new Response("Not found", { status: 404 });
    },
  });
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    headless: true,
    executablePath,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "home"),
      XDG_CACHE_HOME: join(root, "home"),
      XDG_DATA_HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
    },
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage({
    viewport: { width: 1240, height: 1500 },
    deviceScaleFactor: 1,
  });
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/*", (route: any) =>
    new URL(route.request().url()).origin === server.url.origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(server.url.href);
  await page.getByText("Your client ID", { exact: true }).waitFor();
  const temporaryFresh = join(root, "settings-fresh.png"),
    temporaryPaired = join(root, "settings-paired.png");
  await page.screenshot({ path: temporaryFresh, fullPage: true });
  await a.configure({
    enabled: true,
    relayMode: "disabled",
    instanceName: "Smith Lab",
  });
  await b.configure({
    enabled: true,
    relayMode: "disabled",
    instanceName: "Research Node",
  });
  await a.pair({
    clientId: b.identity().clientId,
    alias: "research-node",
    ticket: b.transport.ticket(),
  });
  await b.accept(a.identity().endpointId, a.identity().clientId);
  a.setPolicy(b.identity().endpointId, {
    scope: "named-agents",
    modes: ["queue", "auto"],
    agents: ["research"],
    files: true,
    confirmation: "ALLOW REMOTE ACCESS",
  });
  await a.advertise("research", "research", ["queue", "auto"]);
  await page.reload();
  await page.getByText("research-node", { exact: true }).waitFor();
  await page.screenshot({ path: temporaryPaired, fullPage: true });
  if (errors.length) throw new Error(errors.join("\n"));
  let freshPublished = false;
  try {
    await copyFile(temporaryFresh, freshOutput, constants.COPYFILE_EXCL);
    freshPublished = true;
    await copyFile(temporaryPaired, pairedOutput, constants.COPYFILE_EXCL);
  } catch (error) {
    if (freshPublished) await rm(freshOutput, { force: true });
    throw error;
  }
  console.log(
    "PASS screenshots from real temporary Iroh pairing: settings-fresh.png, settings-paired.png",
  );
} finally {
  const cleanupErrors: unknown[] = [];
  try {
    await browser?.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    server?.stop(true);
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const service of [a, b])
    try {
      await service?.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  try {
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length)
    throw new AggregateError(
      cleanupErrors,
      "Settings screenshot fixture cleanup failed",
    );
}
