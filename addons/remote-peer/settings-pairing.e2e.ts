import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { PeerService } from "./service.js";
import { runAction } from "./index.js";
if (
  process.env.PICLAW_E2E_DISPOSABLE !== "1" ||
  !process.env.PICLAW_E2E_BROWSER
)
  throw new Error("Explicit disposable browser required.");
const require = createRequire(import.meta.url),
  root = await mkdtemp(join(tmpdir(), "iroh-pair-ui-"));
let browser: any,
  server: any,
  a: PeerService | undefined,
  b: PeerService | undefined;
try {
  for (const dir of ["home", "tmp", "bundle"]) await mkdir(join(root, dir));
  const runtime = {
    messaging: {
      version: 1,
      listAdvertisableAgents: async () => [],
      deliverPeerMessage: async () => ({
        status: "ok",
        row_id: 1,
        created: true,
      }),
    },
  } as any;
  a = new PeerService({
    dataDir: join(root, "a"),
    bindAddr: "127.0.0.1:0",
    runtime,
  });
  b = new PeerService({
    dataDir: join(root, "b"),
    bindAddr: "127.0.0.1:0",
    runtime,
  });
  await a.configure({
    enabled: true,
    relayMode: "disabled",
    instanceName: "Alpha",
  });
  await b.configure({
    enabled: true,
    relayMode: "disabled",
    instanceName: "Beta",
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
  });
  if (!built.success) throw Error(String(built.logs));
  const js = await built.outputs[0].text();
  let selected = a;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const p = new URL(req.url).pathname;
      if (p === "/")
        return new Response(
          '<div id="app"></div><script type="module" src="/ui.js"></script>',
          { headers: { "content-type": "text/html" } },
        );
      if (p === "/ui.js")
        return new Response(js, {
          headers: { "content-type": "text/javascript" },
        });
      try {
        if (p.endsWith("/dashboard") && req.method === "POST") {
          const value = await runAction((await req.json()) as any, selected);
          return Response.json({
            ...(await selected!.dashboard()),
            result: value,
          });
        }
        if (p.endsWith("/dashboard"))
          return Response.json(await selected!.dashboard());
        if (p.endsWith("/config"))
          return Response.json({ config: selected!.state.config() });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        );
      }
      return new Response("not found", { status: 404 });
    },
  });
  const { chromium } = await import("playwright");
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PICLAW_E2E_BROWSER,
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
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e: Error) => errors.push(e.message));
  await page.route("**/*", (route: any) =>
    new URL(route.request().url()).origin === server.url.origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(server.url.href);
  await page.getByLabel("Peer client ID").fill(b.identity().clientId);
  await page
    .locator("summary")
    .filter({ hasText: "Optional endpoint ticket" })
    .click();
  await page.locator("textarea").first().fill(b.transport.ticket());
  await page.getByRole("button", { name: "Request pairing" }).click();
  await page.getByText(/outgoing/).waitFor();
  selected = b;
  await page.reload();
  await page.getByText(/incoming/).waitFor();
  page.once("dialog", (d: any) => d.accept(a!.identity().clientId));
  await page.getByRole("button", { name: "Accept" }).click();
  await page.getByText(/paired/).waitFor();
  selected = a;
  await page.reload();
  await page.getByText(/paired/).waitFor();
  await page
    .locator("summary")
    .filter({ hasText: "Incoming permissions" })
    .click();
  const answers = [
    "named-agents",
    "queue,auto",
    "",
    "dismiss",
    "ALLOW REMOTE ACCESS",
  ];
  page.on("dialog", async (d: any) => {
    const answer = answers.shift();
    if (answer === "dismiss") await d.dismiss();
    else await d.accept(answer ?? "");
  });
  await page.getByRole("button", { name: "Edit permissions" }).click();
  await page.getByText(/named-agents · queue, auto · files\s*off/).waitFor();
  if (errors.length) throw Error(errors.join("\n"));
  console.log(
    "PASS two-client Settings pasted ID/ticket pairing, recipient approval and restricted policy edit",
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
      "Settings pairing fixture cleanup failed",
    );
}
