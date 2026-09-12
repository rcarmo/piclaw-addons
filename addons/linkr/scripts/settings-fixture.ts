/** Standalone loopback-only browser fixture; requires installed Playwright and host Preact/HTM bundles. */
import { resolve } from "node:path";
const playwrightPath = process.env.LINKR_FIXTURE_PLAYWRIGHT;
const hostModules = process.env.LINKR_FIXTURE_HOST_MODULES;
if (!playwrightPath || !hostModules)
  throw new Error(
    "Set LINKR_FIXTURE_PLAYWRIGHT to Playwright index.mjs and LINKR_FIXTURE_HOST_MODULES to installed host node_modules.",
  );
const { chromium } = await import(playwrightPath);
const repo = resolve(import.meta.dir, "../../..");
const build = await Bun.build({
  entrypoints: [repo + "/addons/linkr/web/index.ts"],
  target: "browser",
  format: "esm",
});
if (!build.success) throw new Error("build failed");
const bundle = await build.outputs[0].text();
let saved: any;
let snapshotRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/addon.js")
      return new Response(bundle, {
        headers: { "Content-Type": "text/javascript" },
      });
    const files: any = {
      "/preact.js": "preact/dist/preact.umd.js",
      "/hooks.js": "preact/hooks/dist/hooks.umd.js",
      "/htm.js": "htm/dist/htm.umd.js",
    };
    if (files[p])
      return new Response(Bun.file(resolve(hostModules, files[p])), {
        headers: { "Content-Type": "text/javascript" },
      });
    if (p === "/agent/addons/api/linkr/config") {
      if (req.method === "POST") {
        saved = await req.json();
        return Response.json({ ok: true, config: saved });
      }
      return Response.json({ profiles: [] });
    }
    if (p.includes("snapshot")) snapshotRequests++;
    return new Response(
      `<html><head><style>body{font:16px system-ui;background:#171b22;color:#e9eef7;padding:24px;max-width:850px}input{padding:8px;background:#242b35;color:white;border:1px solid #65738b}button{padding:10px;margin:8px}fieldset{border:1px solid #65738b}</style></head><body><div id="root"></div><script src="/preact.js"></script><script src="/hooks.js"></script><script src="/htm.js"></script><script type="module">window.__piclawPreactHtm={...preact,...preactHooks,html:htm.bind(preact.h)};const {default:register}=await import('/addon.js');register({registerSettingsPane(p){preact.render(p.render(),document.getElementById('root'))}});</script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1050, height: 1050 },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.port}`);
  await page.getByRole("button", { name: "Add device" }).click();
  const values = [
    "lab-kvm",
    "Disposable lab KVM",
    "https://kvm.example.test",
    "Disposable installation test PC",
    "linkr/lab-token",
  ];
  for (let i = 0; i < 5; i++)
    await page.locator("input:not([type=checkbox])").nth(i).fill(values[i]);
  if (await page.locator("input[type=checkbox]").isChecked())
    throw new Error("unsafe default");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
  if (
    saved.profiles[0].origin !== values[2] ||
    saved.profiles[0].inputEnabled !== false ||
    snapshotRequests ||
    errors.length
  )
    throw new Error(JSON.stringify({ saved, errors, snapshotRequests }));
  await page.screenshot({
    path: repo + "/addons/linkr/docs/settings-fixture.png",
  });
  console.log(
    "PASS Settings mock browser: render, edit, confirmation, save, HID disabled, no device traffic, no page errors",
  );
} finally {
  await browser.close();
  server.stop(true);
}
