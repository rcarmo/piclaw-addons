import { expect, test } from "bun:test";
import { chromium, webkit } from "playwright";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Real component and direct config handlers, fake local-only model catalogue. No Piclaw service. */
test("Settings model picker loads, saves, persists, disables and survives errors in Chromium/WebKit", async () => {
  const { loadConfig, saveConfig } = await import("./config.js");
  const { setConfig, availableModels } = await import("./index.js");
  const previous = (globalThis as any).__piclawRuntimeInterop;
  (globalThis as any).__piclawRuntimeInterop = {
    getModelRegistry: () => ({
      getAvailable: () => [
        { provider: "fixture", id: "small", name: "Small model" },
        { provider: "fixture", id: "large", name: "Large model" },
      ],
    }),
  };
  let failSave = false;
  const patches: unknown[] = [];
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "web", "index.ts")],
    target: "browser",
  });
  expect(bundle.success).toBe(true);
  const js = await bundle.outputs[0].text();
  const dependency = (name: string, filename: string) =>
    Bun.file(join(dirname(fileURLToPath(import.meta.resolve(name))), filename));
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
<script src="/preact.js"></script><script src="/hooks.js"></script><script src="/htm.js"></script><script>
window.__piclawPreactHtm={html:htm.bind(preact.h),...preactHooks};
window.__piclawSettingsPaneRegistry={registerSettingsPane(p){preact.render(preact.h(p.component),document.getElementById('root'))}};
</script><script type="module" src="/addon.js"></script></body></html>`;
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
      if (path === "/preact.js")
        return new Response(dependency("preact", "preact.umd.js"));
      if (path === "/hooks.js")
        return new Response(dependency("preact/hooks", "hooks.umd.js"));
      if (path === "/htm.js")
        return new Response(dependency("htm", "htm.umd.js"));
      if (path.endsWith("/models"))
        return Response.json({ ok: true, models: availableModels() });
      if (path.endsWith("/config")) {
        if (req.method === "POST") {
          const patch = await req.json();
          patches.push(patch);
          if (failSave)
            return Response.json({ error: "fixture failure" }, { status: 500 });
          return Response.json(setConfig(patch));
        }
        return Response.json({ ok: true, config: loadConfig() });
      }
      return new Response("not found", { status: 404 });
    },
  });
  try {
    for (const engine of [chromium, webkit]) {
      saveConfig({
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
        expect(loadConfig().decision_model).toBe("fixture/small");
        await page.reload();
        await picker.waitFor();
        expect(await picker.inputValue()).toBe("fixture/small");
        failSave = true;
        await picker.selectOption("fixture/large");
        await page
          .getByRole("status")
          .filter({ hasText: "Save failed" })
          .waitFor();
        expect(loadConfig().decision_model).toBe("fixture/small");
        failSave = false;
        await picker.selectOption("");
        await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
        expect(loadConfig().decision_model).toBe("");
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
    expect(() =>
      setConfig({ decision_model: "fixture/nonexistent" }),
    ).toThrow();
  } finally {
    server.stop(true);
    (globalThis as any).__piclawRuntimeInterop = previous;
    saveConfig({ decision_model: "" });
  }
}, 60000);
