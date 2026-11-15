/** Disposable component fixture. Core owns actual Settings-host integration. */
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";

export const settingsBrowserEnabled = process.env.PICLAW_E2E_DISPOSABLE === "1"
  && !!process.env.PICLAW_SETTINGS_CORE_SOURCE;

const visualSettingsPanel = "runtime/web/static/visual/frontend/src/panels/SettingsPanel.tsx";
/** Core removed the Visual shell (piclaw #1990); older companion cores still ship it. */
const visualSkinAvailable = settingsBrowserEnabled
  && existsSync(join(process.env.PICLAW_SETTINGS_CORE_SOURCE!, visualSettingsPanel));

/** Filters a skin matrix down to the shells the companion core actually provides. */
export function availableSkins<T extends string>(skins: readonly T[]): T[] {
  return skins.filter((skin) => skin !== "visual" || visualSkinAvailable);
}

export async function settingsPaneFixture(entry: string, options: { realHost?: boolean } = {}) {
  const core = process.env.PICLAW_SETTINGS_CORE_SOURCE!;
  if (!settingsBrowserEnabled || !core.startsWith("/")) throw new Error("Explicit disposable companion core required");
  const { chromium } = await import(join(core, "node_modules/playwright/index.mjs"));
  const root = mkdtempSync(join(tmpdir(), "addon-settings-fixture-"));
  let browser: any;
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const hostRequire = createRequire(join(core, "package.json"));
    const preact = hostRequire.resolve("preact");
    const hooks = hostRequire.resolve("preact/hooks");
    const htm = hostRequire.resolve("htm");
    const shim = join(root, "entry.ts");
    await Bun.write(shim, `
      import {h,render} from ${JSON.stringify(preact)};
      import * as hooks from ${JSON.stringify(hooks)};
      import htm from ${JSON.stringify(htm)};
      const skin=new URLSearchParams(location.search).get('skin');
      const root=document.getElementById('app');
      if (${options.realHost === true} && skin==='classic') {
        const vendor=await import(${JSON.stringify(join(core, "runtime/web/src/vendor/preact-htm.js"))});
        const registry=await import(${JSON.stringify(join(core, "runtime/web/src/components/settings/pane-registry.ts"))});
        const {requestOpenSettingsDialog}=await import(${JSON.stringify(join(core, "runtime/web/src/components/settings-dialog-events.ts"))});
        const {SettingsDialogContent}=await import(${JSON.stringify(join(core, "runtime/web/src/components/settings-dialog.ts"))});
        globalThis.__piclawPreactHtm=vendor;
        globalThis.__piclawSettingsPaneRegistry=registry;
        globalThis.__piclaw_web=registry;
        await import('/addon/index.ts');
        requestOpenSettingsDialog({section:registry.getRegisteredSettingsPanes()[0].id});
        vendor.render(vendor.h(SettingsDialogContent,{onClose:()=>{}}),root);
${visualSkinAvailable ? `      } else if (${options.realHost === true && visualSkinAvailable} && skin==='visual') {
        const registry=await import(${JSON.stringify(join(core, "runtime/web/static/visual/frontend/src/panels/settings/pane-registry.ts"))});
        const {SettingsPanel}=await import(${JSON.stringify(join(core, "runtime/web/static/visual/frontend/src/panels/SettingsPanel.tsx"))});
        globalThis.__piclawPreactHtm={html:htm.bind(h),...hooks};
        globalThis.__piclawSettingsPaneRegistry={...registry,registerSettingsPane:registry.registerAddonSettingsPane};
        globalThis.__piclaw_web=globalThis.__piclawSettingsPaneRegistry;
        await import('/addon/index.ts');
        localStorage.setItem('piclaw-settings-category',registry.getRegisteredPanes().find(p=>p.source==='addon').id);
        render(h(SettingsPanel),root);
` : ""}      } else {
        globalThis.__piclawPreactHtm={html:htm.bind(h),...hooks};
        globalThis.__piclawSettingsPaneRegistry={registerSettingsPane:({component})=>render(h(component),root),notifySettingsPanesChanged:()=>{}};
        globalThis.__piclaw_web=globalThis.__piclawSettingsPaneRegistry;
        await import('/addon/index.ts');
      }
    `);
    const built = await Bun.build({ entrypoints: [shim], target: "browser", external: ["/addon/index.ts"], plugins: [{
      name: "single-preact", setup(build) {
        build.onResolve({ filter: /^preact$/ }, () => ({ path: preact }));
      },
    }] });
    if (!built.success) throw new Error(String(built.logs));
    const js = await built.outputs[0].text();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/agent/settings-data") return Response.json({});
      if (url.pathname === "/ui.js") return new Response(js, { headers: { "content-type": "text/javascript" } });
      // Production serves exact asset paths and transpiles each module; it does
      // not bundle or resolve a missing .js import to a neighbouring .ts file.
      if (url.pathname.startsWith("/addon/")) {
        const directory = dirname(entry);
        const path = resolve(directory, url.pathname.slice("/addon/".length));
        if (!path.startsWith(directory + "/")) return new Response(null, { status: 404 });
        const file = Bun.file(path);
        if (!await file.exists()) return new Response(null, { status: 404 });
        const code = new Bun.Transpiler({ loader: extname(path) === ".ts" ? "ts" : "js" }).transformSync(await file.text());
        return new Response(code, { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname.startsWith("/static/") && !url.pathname.includes("..")) {
        const file = Bun.file(join(core, "runtime/web", url.pathname));
        return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
      }
      if (url.pathname !== "/") return new Response("Unexpected fixture request", { status: 404 });
      const skin = url.searchParams.get("skin");
      const modern = skin === "classic" || skin === "visual";
      const cls = modern && !options.realHost ? `${skin === "classic" ? "settings-content" : "settings-panel__content"} settings-addon-pane` : "";
      return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        ${modern ? `<link rel="stylesheet" href="/static/${skin}/css/styles.css">` : ""}
        <style>:root{--bg-primary:#fff;--bg-secondary:#f7f9fa;--text-primary:#18212a;--text-secondary:#54606c;--border-color:#b7bfc7;--accent-color:#2783b8;--danger-color:#b3261e}@media(prefers-color-scheme:dark){:root{--bg-primary:#17212a;--bg-secondary:#202b36;--text-primary:#edf3f7;--text-secondary:#b3c1ce;--border-color:#526273}}body{margin:0;overflow:auto;font:15px system-ui}#app{box-sizing:border-box;width:100%;${options.realHost && modern ? "height:100vh" : "max-width:850px;height:auto;min-height:0;padding:12px;overflow:visible"}}</style>
        </head><body><main id="app" class="${cls}"></main><script type="module" src="/ui.js"></script></body></html>`, { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    return {
      async page(skin: string, width = 390, colorScheme: "light" | "dark" = "light") {
        const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
        page.setDefaultTimeout(5000);
        const errors: string[] = [];
        page.on("pageerror", (e: Error) => errors.push(e.message));
        await page.route("**/*", (route: any) => new URL(route.request().url()).origin === server!.url.origin ? route.continue() : route.abort());
        return { page, errors, url: server!.url.href + "?skin=" + skin };
      },
      async close() { await browser.close(); server!.stop(true); rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await browser?.close(); server?.stop(true); rmSync(root, { recursive: true, force: true }); throw error;
  }
}
