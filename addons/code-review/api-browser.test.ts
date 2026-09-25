import { expect, test } from "bun:test";
import { chromium } from "playwright";
import { requestId } from "./web/api.ts";

test("request IDs remain UUID-shaped and unique", () => {
  const ids = Array.from({ length: 100 }, requestId);
  expect(new Set(ids).size).toBe(ids.length);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("HTTP hostname without randomUUID can create cryptographic request IDs", async () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname === "/web/api.ts") {
          const source = await Bun.file(new URL("./web/api.ts", import.meta.url)).text();
          const transpiled = new Bun.Transpiler({ loader: "ts", target: "browser" }).transformSync(source);
          return new Response(transpiled, { headers: { "Content-Type": "text/javascript" } });
        }
        return new Response("<script type=module>import {requestId} from '/web/api.ts'; window.reviewRequestId=requestId</script>", {
          headers: { "Content-Type": "text/html" },
        });
      },
    });
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"],
      executablePath: process.env.PICLAW_REVIEW_TEST_BROWSER || undefined });
    const page = await browser.newPage();
    // Chromium does not treat a synthetic hostname on HTTP as a secure context.
    await page.route("http://review.test:*/**", (route) => route.continue({ url: route.request().url().replace("review.test", "127.0.0.1") }));
    await page.goto(`http://review.test:${server.port}/`);
    const result = await page.evaluate(async () => {
      await Promise.resolve();
      const ids = Array.from({ length: 12 }, () => (window as any).reviewRequestId());
      return { secure: isSecureContext, uuid: typeof crypto.randomUUID, random: typeof crypto.getRandomValues, ids };
    });
    expect(result.secure).toBe(false);
    expect(result.uuid).toBe("undefined");
    expect(result.random).toBe("function");
    expect(new Set(result.ids).size).toBe(12);
    for (const id of result.ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally {
    await browser?.close();
    server?.stop(true);
  }
}, 30000);
