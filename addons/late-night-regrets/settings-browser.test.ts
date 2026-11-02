import { expect, test } from "bun:test";
import { chromium, webkit } from "playwright";
import { join } from "node:path";

/** Real component and direct config handlers, fake local-only model catalogue. No Piclaw service. */
test("Settings model picker loads, saves, persists, disables and survives errors in Chromium/WebKit", async () => {
  const { normaliseConfig } = await import("./config.js");
  const { createLateNightRegrets } = await import("./native.js");
  let config = normaliseConfig({});
  const native = createLateNightRegrets({ chat: 'web:settings-fixture', cwd: '/fixture', assertCurrent() {}, assertSingleUser() {},
    config: { get: () => config, set(value) { config = value; } },
    async history() { throw Error('Settings must not access history'); }, async readFile() { throw Error('Settings must not read files'); },
    async admitConversationInput() { throw Error('Settings must not admit input'); },
    accountedDecision: { getAvailable: () => ['small', 'large'].map(id => ({ provider: 'fixture', id,
      name: id === 'small' ? 'Small model' : 'Large model', api: 'openai-completions' as const,
      baseUrl: 'https://fixture.invalid', input: ['text' as const], reasoning: false, maxTokens: 1024, contextWindow: 16000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })), async complete() { throw Error('Settings must not execute a model'); } },
  });
  let failSave = false;
  const patches: unknown[] = [];
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "web", "index.ts")],
    target: "browser",
  });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs[0].text();
  const hostBundle = await Bun.build({
    entrypoints: ["fixture:host"],
    plugins: [{ name: "host-fixture", setup(build) {
      build.onResolve({ filter: /^fixture:host$/ }, () => ({ path: "host", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "import * as preact from \"preact\"; import * as hooks from \"preact/hooks\"; import htm from \"htm\"; globalThis.preact = preact; globalThis.preactHooks = hooks; globalThis.htm = htm;", loader: "js" }));
    } }],
    target: "browser",
  });
  expect(hostBundle.success).toBe(true);
  const hostJs = await hostBundle.outputs[0].text();
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
<script type="module">
import "/host.js";
window.__piclawPreactHtm={html:htm.bind(preact.h),...preactHooks};
window.__piclawSettingsPaneRegistry={registerSettingsPane(p){preact.render(preact.h(p.component),document.getElementById('root'))}};
await import("/addon.js");</script></body></html>`;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/")
        return new Response(html, { headers: { "content-type": "text/html" } });
      if (path === "/addon.js")
        return new Response(js, {
          headers: { "content-type": "application/javascript" },
        });
      if (path === "/host.js")
        return new Response(hostJs, { headers: { "content-type": "application/javascript" } });
      if (path.endsWith("/models"))
        return Response.json(native.settings.models.get());
      if (path.endsWith("/config")) {
        if (req.method === "POST") {
          const patch = await req.json();
          patches.push(patch);
          if (failSave)
            return Response.json({ error: "fixture failure" }, { status: 500 });
          return Response.json(await native.settings.config.set(patch));
        }
        return Response.json(native.settings.config.get());
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    for (const engine of [chromium, webkit]) {
      config = normaliseConfig({
        enabled: true,
        decision_model: "",
        review_budget_tokens: 16000,
      });
      const browser = await engine.launch({ headless: true });
      try {
        const page = await browser.newPage({
          viewport: { width: 390, height: 844 },
        });
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(`http://127.0.0.1:${server.port}`);
        const picker = page.getByLabel("Decision model", { exact: true });
        await picker.waitFor();
        expect(await picker.inputValue()).toBe("");
        await picker.selectOption("fixture/small");
        await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
        expect(native.getConfig().decision_model).toBe("fixture/small");
        await page.reload();
        await picker.waitFor();
        expect(await picker.inputValue()).toBe("fixture/small");
        failSave = true;
        await picker.selectOption("fixture/large");
        await page
          .getByRole("status")
          .filter({ hasText: "Save failed" })
          .waitFor();
        expect(native.getConfig().decision_model).toBe("fixture/small");
        failSave = false;
        await picker.selectOption("");
        await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
        expect(native.getConfig().decision_model).toBe("");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    }
    expect(patches.length).toBe(6);
    await expect(native.setConfig({ decision_model: "fixture/nonexistent" })).rejects.toThrow();
  } finally {
    server.stop(true);

  }
}, 60000);
