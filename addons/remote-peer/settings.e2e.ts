/** Isolated Settings UI fixture only; never connects to a running Piclaw instance. */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { PeerService } from "./service.js";
const require = createRequire(import.meta.url);
export async function testSettings() {
  if (process.env.PICLAW_E2E_DISPOSABLE !== "1")
    throw new Error(
      "Set PICLAW_E2E_DISPOSABLE=1 to run the owned local Settings fixture.",
    );
  const executablePath = process.env.PICLAW_E2E_BROWSER;
  if (!executablePath)
    throw new Error("Set PICLAW_E2E_BROWSER to an installed Chromium binary.");
  const { chromium } = await import("playwright");
  const root = await mkdtemp(join(tmpdir(), "iroh-ui-"));
  let browser: any, server: any, service: PeerService | undefined;
  try {
    for (const dir of ["home", "tmp", "bundle"]) await mkdir(join(root, dir));
    service = new PeerService({
      dataDir: root,
      bindAddr: "127.0.0.1:0",
      runtime: {
        messaging: {
          version: 1,
          listAdvertisableAgents: async () => [],
          deliverPeerMessage: async () => ({}),
        },
      } as any,
    });
    await service.configure({ relayMode: "disabled" });
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
        const p = new URL(req.url).pathname;
        if (p === "/")
          return new Response(
            '<!doctype html><html><head><style>:root{--bg-primary:#fff;--text-primary:#222;--border-color:#aaa;}body{font:14px system-ui;margin:16px}</style></head><body><div id="app"></div><script type="module" src="/ui.js"></script></body></html>',
            { headers: { "Content-Type": "text/html" } },
          );
        if (p === "/ui.js")
          return new Response(js, {
            headers: { "Content-Type": "text/javascript" },
          });
        try {
          if (p.endsWith("/dashboard"))
            return Response.json(await service!.dashboard());
          if (p.endsWith("/config"))
            return Response.json({
              config:
                req.method === "POST"
                  ? await service!.configure((await req.json()) as any)
                  : service!.state.config(),
            });
        } catch (error) {
          return Response.json({ error: String(error) }, { status: 400 });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    const env = {
      PATH: process.env.PATH || "/usr/bin:/bin",
      HOME: join(root, "home"),
      XDG_CONFIG_HOME: join(root, "home"),
      XDG_CACHE_HOME: join(root, "home"),
      XDG_DATA_HOME: join(root, "home"),
      TMPDIR: join(root, "tmp"),
    };
    browser = await chromium.launch({
      headless: true,
      executablePath,
      env,
      args: ["--no-sandbox"],
    });
    const page = await browser.newPage({
      viewport: { width: 1200, height: 1000 },
    });
    const errors: string[] = [];
    page.on("pageerror", (e: Error) => {
      errors.push(e.message);
      console.log("UI error", e.message);
    });
    page.on("console", (m: any) => {
      if (m.type() === "error") console.log(m.text());
    });
    await page.route("**/*", (route: any) =>
      new URL(route.request().url()).origin === server.url.origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(server.url.href);
    await page.getByText("Your client ID", { exact: true }).waitFor();
    if (await page.getByRole("checkbox", { name: /Enable mDNS/ }).isChecked())
      throw new Error("mDNS default must be off");
    if (
      await page
        .getByRole("checkbox", { name: /Internet address lookup/ })
        .isChecked()
    )
      throw new Error("Lookup requires opt-in");
    await page.getByLabel("Peer client ID").fill("PCL1-TEST");
    await page
      .getByRole("checkbox", { name: "Enable Remote Peer", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Listening"),
    );
    if (service.discovery !== null)
      throw new Error("Enabling Iroh started mDNS");
    if (
      await page
        .getByRole("button", { name: "Request pairing", exact: true })
        .isDisabled()
    )
      throw new Error("Settings pairing control unavailable");
    await page
      .getByRole("checkbox", { name: "Enable Remote Peer", exact: true })
      .click();
    await page.waitForFunction(() =>
      document.body.innerText.includes("Stopped ·"),
    );
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(
      "PASS isolated Settings render, client-ID field, default-off discovery/lookup, enable/disable Iroh without multicast",
    );
  } finally {
    await browser?.close();
    server?.stop(true);
    await service?.close();
    await rm(root, { recursive: true, force: true });
  }
}
if (import.meta.main) await testSettings();
