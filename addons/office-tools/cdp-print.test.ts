import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureBrowser, findBrowser } from "./cdp-print.ts";

const servers: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("findBrowser discovers an installed Chromium-family browser", () => {
  const browser = findBrowser();
  expect(browser === null || ["Edge", "Chrome", "Chromium"].includes(browser.name)).toBe(true);
});

test("ensureBrowser skips a CDP port owned by another workflow", async () => {
  const occupied = await new Promise<number>((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "unrelated-session", webSocketDebuggerUrl: "ws://127.0.0.1/ignored" }));
    });
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  const profileRoot = mkdtempSync(join(tmpdir(), "office-tools-cdp-test-"));
  tempDirs.push(profileRoot);
  const result = await ensureBrowser(undefined, {
    ports: [occupied],
    browser: { command: "this-browser-must-not-launch", name: "Fake" },
    profileRoot,
  });
  expect(result).toBeNull();
});
