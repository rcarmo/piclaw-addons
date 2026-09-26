import { afterAll, beforeAll, expect, test } from "bun:test";
import { settingsBrowserEnabled, settingsPaneFixture } from "../../scripts/lib/settings-pane-browser.js";

const browserTest = settingsBrowserEnabled ? test : test.skip;
let fixture: Awaited<ReturnType<typeof settingsPaneFixture>>;

beforeAll(async () => {
  if (settingsBrowserEnabled) {
    fixture = await settingsPaneFixture(new URL("./web/index.ts", import.meta.url).pathname, { realHost: true });
  }
});

afterAll(async () => { await fixture?.close(); });

const initialConfig = () => ({
  enabled: false,
  repository: { backend: "local", path: "/initial/restic", expectedMount: "/initial" },
  passwordRef: "restic/password",
  retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 6 },
  binary: "restic",
  excludes: ["/cache"],
  schedule: { enabled: false, hours: [0], minute: 0, timezone: "UTC" },
  migrationAcknowledged: false,
});

for (const skin of ["classic", "visual"] as const) {
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [390, 1280]) {
      browserTest(`Restic ${skin} ${colorScheme} ${width}px: same-skin settings fixture`, async () => {
        const { page, errors, url } = await fixture.page(skin, width, colorScheme);
        let config = initialConfig();
        let statusState: any = {
          running: false,
          lastAttempt: "2025-01-01T00:00:00.000Z",
          lastSuccess: "2025-01-01T00:00:01.000Z",
          nextRun: "2025-01-01T01:00:00.000Z",
          backup: { status: "success" },
          maintenance: { status: "idle" },
          logs: [],
        };
        const configWrites: any[] = [];
        const actions: any[] = [];
        let statusGets = 0;
        let rejectConfig = false;
        let rejectCheck = false;
        const forbiddenSecret = "fixture-secret-not-in-ui";

        // Direct API mocks are scoped to this disposable browser page only.
        await page.route("**/agent/addons/api/restic/config", async (route: any) => {
          if (route.request().method() === "GET") {
            return route.fulfill({ json: {
              ok: true,
              config,
              paths: { sources: [{ name: "workspace", path: "/workspace" }], stateDir: "/state/restic", stageDir: "/stage/restic" },
              binary: { path: "/usr/bin/restic", version: "restic 0.17.3" },
              migration: { scheduler: "operator-owned" },
            } });
          }
          const body = route.request().postDataJSON();
          configWrites.push(body);
          if (rejectConfig) return route.fulfill({ status: 400, json: { ok: false, error: { message: "Configuration rejected" } } });
          config = body.config;
          return route.fulfill({ json: { ok: true, config } });
        });
        await page.route("**/agent/addons/api/restic/status", async (route: any) => {
          statusGets++;
          return route.fulfill({ json: { ok: true, state: statusState } });
        });
        await page.route("**/agent/addons/api/restic/action", async (route: any) => {
          const body = route.request().postDataJSON();
          actions.push(body);
          if (body.action === "installBinary") config.binary = 'managed';
          if (body.action === "check" && rejectCheck) {
            return route.fulfill({ status: 422, json: { ok: false, error: `password=${forbiddenSecret}` } });
          }
          const result = body.action === "snapshots"
            ? { snapshots: [{ id: "snap-001", time: "2025-01-01T00:00:00.000Z", hostname: "fixture", paths: ["workspace"] }] }
            : body.action === "previewRetention"
              ? { preview: { token: "preview-token-001", ids: ["snap-001"] } }
              : { status: body.action === "cancel" ? "cancelled" : "ok", action: body.action };
          statusState = { ...statusState, running: false, lastAttempt: "2025-01-01T00:00:02.000Z", logs: [`password=${forbiddenSecret}`] };
          return route.fulfill({ json: { ok: true, result, state: statusState } });
        });
        await page.route("**/agent/keychain", async (route: any) => {
          if (route.request().method() !== "GET") throw new Error("The settings pane must not write keychain secrets");
          return route.fulfill({ json: { ok: true, entries: [
            { name: "restic/password" }, { name: "ssh/backup" }, { name: "ssh/known-hosts" },
            { name: "s3/access" }, { name: "s3/secret" }, { name: "s3/session" }, { name: "azure/account-key" },
          ] } });
        });

        const heading = page.getByRole("heading", { name: "Restic backup", exact: true });
        const save = page.getByRole("button", { name: "Save configuration", exact: true });
        const saveAndReload = async (expectedRepository: any) => {
          const before = configWrites.length;
          await save.click();
          await page.getByRole("status").filter({ hasText: "Configuration saved." }).waitFor();
          expect(configWrites).toHaveLength(before + 1);
          expect(configWrites.at(-1).config.repository).toEqual(expectedRepository);
          await page.reload();
          await heading.waitFor();
          expect(await page.locator("#restic-repository-backend").inputValue()).toBe(expectedRepository.backend);
        };
        const completeAction = async (name: string) => {
          await page.getByRole("button", { name, exact: true }).click();
          await page.getByRole("status").filter({ hasText: "Action completed." }).waitFor();
        };

        try {
          await page.goto(url);
          await heading.waitFor();
          expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(colorScheme === "dark");

          // Exercise every repository editor through the registered pane and check it after a GET-backed reload.
          await page.locator("#restic-local-path").fill("/backups/restic");
          await page.locator("#restic-local-mount").fill("/backups");
          await saveAndReload({ backend: "local", path: "/backups/restic", expectedMount: "/backups" });
          expect(await page.locator("#restic-local-path").inputValue()).toBe("/backups/restic");

          await page.locator("#restic-repository-backend").selectOption("sftp");
          await page.locator("#restic-sftp-host").fill("backup.example.test");
          await page.locator("#restic-sftp-port").fill("2222");
          await page.locator("#restic-sftp-user").fill("backup");
          await page.locator("#restic-sftp-path").fill("/srv/restic");
          await page.locator("#restic-sftp-key").fill("ssh/backup");
          await page.locator("#restic-sftp-known-hosts").fill("ssh/known-hosts");
          await saveAndReload({ backend: "sftp", host: "backup.example.test", port: 2222, user: "backup", path: "/srv/restic", privateKeyRef: "ssh/backup", knownHostsRef: "ssh/known-hosts" });
          expect(await page.locator("#restic-sftp-key").inputValue()).toBe("ssh/backup");
          expect(await page.locator("#restic-sftp-known-hosts").inputValue()).toBe("ssh/known-hosts");

          await page.locator("#restic-repository-backend").selectOption("s3");
          await page.locator("#restic-s3-endpoint").fill("https://s3.example.test");
          await page.locator("#restic-s3-region").fill("us-east-1");
          await page.locator("#restic-s3-bucket").fill("backup-bucket");
          await page.locator("#restic-s3-prefix").fill("smith/daily");
          await page.locator("#restic-s3-access").fill("s3/access");
          await page.locator("#restic-s3-secret").fill("s3/secret");
          await page.locator("#restic-s3-session").fill("s3/session");
          await saveAndReload({ backend: "s3", endpoint: "https://s3.example.test", region: "us-east-1", bucket: "backup-bucket", prefix: "smith/daily", accessKeyRef: "s3/access", secretKeyRef: "s3/secret", sessionTokenRef: "s3/session" });
          expect(await page.locator("#restic-s3-access").inputValue()).toBe("s3/access");
          expect(await page.locator("#restic-s3-secret").inputValue()).toBe("s3/secret");
          expect(await page.locator("#restic-s3-session").inputValue()).toBe("s3/session");

          await page.locator("#restic-repository-backend").selectOption("azure");
          await page.locator("#restic-azure-account").fill("backupaccount");
          await page.locator("#restic-azure-container").fill("backups");
          await page.locator("#restic-azure-prefix").fill("smith");
          await page.locator("#restic-azure-key").fill("azure/account-key");
          await saveAndReload({ backend: "azure", account: "backupaccount", container: "backups", prefix: "smith", accountKeyRef: "azure/account-key" });
          expect(await page.locator("#restic-azure-key").inputValue()).toBe("azure/account-key");
          expect(await page.getByLabel("Repository password ref", { exact: true }).inputValue()).toBe("restic/password");

          // Save errors are surfaced and a fresh GET retains the last accepted configuration.
          rejectConfig = true;
          await page.locator("#restic-binary").fill("restic-rejected");
          await save.click();
          await page.getByRole("alert").filter({ hasText: "Configuration rejected" }).waitFor();
          rejectConfig = false;
          await page.reload();
          await heading.waitFor();
          expect(await page.locator("#restic-binary").inputValue()).toBe("restic");

          // Initial loading does not poll; only the explicit refresh below hits status again.
          statusGets = 0;
          await page.waitForTimeout(250);
          expect(statusGets).toBe(0);

          await completeAction("Test connection");
          await completeAction("Back up now");
          await completeAction("List snapshots");
          expect(await page.getByText("snap-001", { exact: true }).count()).toBeGreaterThan(0);

          rejectCheck = true;
          await page.getByRole("button", { name: "Check metadata", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "password=[redacted]" }).waitFor();
          expect(await page.locator(".restic-settings").innerText()).not.toContain(forbiddenSecret);
          rejectCheck = false;
          await completeAction("Check metadata");

          await completeAction("Preview retention");
          const applyRetention = page.getByRole("button", { name: "Apply retention", exact: true });
          expect(await applyRetention.isEnabled()).toBe(true);

          let confirmationMessage = "";
          const actionCount = actions.length;
          page.once("dialog", async (dialog: any) => { confirmationMessage = dialog.message(); await dialog.dismiss(); });
          await applyRetention.click();
          await page.waitForTimeout(100);
          expect(confirmationMessage).toContain("DELETE PREVIEWED SNAPSHOTS");
          expect(actions).toHaveLength(actionCount);
          page.once("dialog", (dialog: any) => dialog.accept());
          await applyRetention.click();
          await page.getByRole("status").filter({ hasText: "Action completed." }).waitFor();
          expect(actions.at(-1)).toEqual({ action: "applyRetention", token: "preview-token-001", ids: ["snap-001"], confirmation: "DELETE PREVIEWED SNAPSHOTS" });

          const init = page.getByRole("button", { name: "Init repository", exact: true });
          confirmationMessage = "";
          const beforeInitCancel = actions.length;
          page.once("dialog", async (dialog: any) => { confirmationMessage = dialog.message(); await dialog.dismiss(); });
          await init.click();
          await page.waitForTimeout(100);
          expect(confirmationMessage).toContain("INITIALISE REPOSITORY");
          expect(actions).toHaveLength(beforeInitCancel);
          page.once("dialog", (dialog: any) => dialog.accept());
          await init.click();
          await page.getByRole("status").filter({ hasText: "Action completed." }).waitFor();
          expect(actions.at(-1)).toEqual({ action: "init", confirmation: "INITIALISE REPOSITORY" });

          await page.getByLabel("Restore target (empty absolute directory)", { exact: true }).fill("/tmp/restic-restore");
          const restore = page.getByRole("button", { name: "Restore", exact: true });
          expect(await restore.isEnabled()).toBe(true);
          confirmationMessage = "";
          const beforeRestoreCancel = actions.length;
          page.once("dialog", async (dialog: any) => { confirmationMessage = dialog.message(); await dialog.dismiss(); });
          await restore.click();
          await page.waitForTimeout(100);
          expect(confirmationMessage).toContain("RESTORE TO EMPTY DIRECTORY");
          expect(actions).toHaveLength(beforeRestoreCancel);
          page.once("dialog", (dialog: any) => dialog.accept());
          await restore.click();
          await page.getByRole("status").filter({ hasText: "Action completed." }).waitFor();
          expect(actions.at(-1)).toEqual({ action: "restore", snapshot: "snap-001", target: "/tmp/restic-restore", confirmation: "RESTORE TO EMPTY DIRECTORY" });

          await completeAction("Cancel");
          expect(actions.at(-1)).toEqual({ action: "cancel" });

          const beforeRefresh = statusGets;
          await page.getByRole("button", { name: "Refresh status", exact: true }).click();
          await page.getByRole("status").filter({ hasText: "Status refreshed." }).waitFor();
          expect(statusGets).toBe(beforeRefresh + 1);
          await page.waitForTimeout(250);
          expect(statusGets).toBe(beforeRefresh + 1);

          const beforeInstall=actions.length;
          page.once('dialog',(dialog:any)=>dialog.dismiss());
          await page.getByRole('button',{name:'Install verified Restic',exact:true}).click();
          expect(actions.length).toBe(beforeInstall);
          page.once('dialog',(dialog:any)=>dialog.accept());
          await page.getByRole('button',{name:'Install verified Restic',exact:true}).click();
          await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('#restic-binary')?.value==='managed');
          expect(actions.at(-1)).toEqual({action:'installBinary',confirmation:'INSTALL VERIFIED RESTIC'});

          expect(configWrites.some(write => JSON.stringify(write).includes(forbiddenSecret))).toBe(false);
          expect(actions.some(action => JSON.stringify(action).includes(forbiddenSecret))).toBe(false);
          expect(await page.locator(".restic-settings").evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
          expect(await page.locator(".restic-settings").innerText()).not.toContain(forbiddenSecret);
          expect(errors).toEqual([]);
        } finally {
          await page.close();
        }
      }, 60000);
    }
  }
}
