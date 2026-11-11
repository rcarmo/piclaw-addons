import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

test("observability web entry only registers the settings pane", () => {
  expect(source).toContain("scheduleObservabilitySettingsPaneRegistration");
  expect(source).not.toContain("APP_INSIGHTS_SDK_URL");
  expect(source).not.toContain("browser-config");
  expect(source).not.toContain("EventSource");
  expect(source).not.toContain("window.fetch");
  expect(source).not.toContain("trackEvent");
  expect(source).not.toContain("trackPageView");
});

test("settings pane no longer exposes browser telemetry controls", () => {
  expect(source).not.toContain("appinsights_browser_enabled");
  expect(source).not.toContain("Browser agent telemetry");
});

test('settings preserve backend warnings and do not overwrite a failed config write with keychain success',()=>{
 expect(source).toContain('setMsg(j.warning || "Saved")');
 expect(source).toContain('if (result?.ok && !result.warning)');
 expect(source).not.toContain('setTimeout(() => setMsg("")');
 expect(source).toContain('msg || "Loading…"');
});
