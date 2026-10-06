import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const consumer = process.env.PICLAW_DELEGATE_AUTH_CONSUMER;
const archives = process.env.PICLAW_DELEGATE_AUTH_ARCHIVES;
const integration = process.env.PICLAW_E2E_DISPOSABLE === "1" && consumer && archives ? test : test.skip;
const receipt = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/child-auth-101.json"), "utf8"));

test("exact1.0.1 child auth receipt binds fresh artifacts and bounded synthetic scope", () => {
  expect(receipt.referenceGitHead).toBe("a7229ddc21810d6245105978033b7df645ecc2f7");
  expect(receipt.filesCompared).toBe(561); expect(receipt.receipt.version).toBe("1.0.1");
  expect(receipt.receipt.networkAttempts).toBe(0);
  expect(createHash("sha256").update(readFileSync(join(import.meta.dir, "fixtures/child-auth-101.log"))).digest("hex")).toBe(receipt.rawLogSha256);
  expect(receipt.sandbox).toEqual({ capabilities: { CapEff: "0000000000000000", CapPrm: "0000000000000000", CapBnd: "0000000000000000", CapAmb: "0000000000000000" }, noNewPrivs: 1, nonRoot: true, devices: ["lo"] });
  expect(receipt.receipt.rows.map((row: { mode: string; authRequests: number; observations: number; refreshes: number }) => [row.mode,row.authRequests,row.observations,row.refreshes])).toEqual([
    ["rotate",2,2,1],["api-key-env",2,2,0],["logout",2,1,0],["denied",1,0,0],["disconnect",2,1,0],["terminate",2,1,0],
  ]);
  expect(receipt.limits).toContain("production Delegate unchanged");
  expect(receipt.limits).toContain("no atomic logout-to-dispatch guarantee");
  const repo=resolve(import.meta.dir,"../..");
  for(const [path,hash] of Object.entries(receipt.fingerprints as Record<string,string>)) expect(createHash("sha256").update(readFileSync(join(repo,path))).digest("hex")).toBe(hash);
});

const integrities = {
  "pi-ai": "sha512-eSA53pdfDLuQTTJn3yz1VC8BBmcX33OKkk8WihOXdVBvbgqqC4zuR6Sf+TeeWuAmh8LuqARoK14R1s2HZqVcsw==",
  "pi-coding-agent": "sha512-B7FGYpHpBPvS+Ux16CbCuVnE9S4v6c2h6ykocPNarC4msD/4JM/eFrCrO2wbRkedJZ25myFozSWHvCOx4QnN+w=="
};

integration("public Pi 1.0.1 child auth pipe resolves per request and fails closed", async () => {
  if (!consumer || !archives || !isAbsolute(consumer) || !isAbsolute(archives)) throw Error("Explicit isolated consumer/archive paths required");
  const oldNamespace = process.env.PICLAW_DELEGATE_PARENT_NETNS;
  if (process.platform !== "linux" || !oldNamespace || readlinkSync("/proc/self/ns/net") === oldNamespace) throw Error("Separate network namespace required");
  const devices = readFileSync("/proc/net/dev", "utf8").split("\n").filter(line => line.includes(":"));
  expect(devices.map(line => line.split(":")[0].trim())).toEqual(["lo"]);
  const status = readFileSync("/proc/self/status", "utf8");
  const capabilities = Object.fromEntries(["CapEff", "CapPrm", "CapBnd", "CapAmb"].map(key => {
    const value = status.split("\n").find(line => line.startsWith(key + ":"))?.split(":")[1].trim();
    expect(value, key).toBe("0000000000000000"); return [key, value];
  }));
  const noNewPrivs = Number(status.match(/^NoNewPrivs:\s+(\d+)$/m)?.[1]);
  expect(noNewPrivs).toBe(1); expect(process.getuid?.()).not.toBe(0);
  const sandbox = { capabilities, noNewPrivs, nonRoot: process.getuid?.() !== 0, devices: ["lo"] };
  const root = mkdtempSync(join(tmpdir(), "delegate-auth101-"));
  try {
    let filesCompared = 0;
    for (const [name, integrity] of Object.entries(integrities)) {
      const archive = join(archives, `${name}-1.0.1.tgz`);
      expect("sha512-" + createHash("sha512").update(readFileSync(archive)).digest("base64")).toBe(integrity);
      const unpack = join(root, name); mkdirSync(unpack);
      expect(Bun.spawnSync(["tar", "-xzf", archive, "-C", unpack], { stderr: "pipe" }).exitCode).toBe(0);
      const source = join(unpack, "package"), installed = join(consumer, "node_modules/@earendil-works", name);
      expect(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")).version).toBe("1.0.1");
      const walk = (dir: string): string[] => readdirSync(join(source, dir), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
      for (const path of walk("").filter(path => path === "package.json" || path.startsWith("dist/") && /\.(?:js|json)$/.test(path))) {
        expect(readFileSync(join(source, path)).equals(readFileSync(join(installed, path))), `${name}/${path}`).toBe(true); filesCompared++;
      }
    }
    expect(filesCompared).toBeGreaterThan(100);
    const scripts = import.meta.dir;
    cpSync(join(scripts, "delegate-auth-101-parent.ts"), join(root, "parent.ts"));
    cpSync(join(scripts, "delegate-auth-101-child.ts"), join(root, "child.ts"));
    symlinkSync(join(consumer, "node_modules"), join(root, "node_modules"), "dir");
    const scenarios = join(root, "scenarios"); mkdirSync(scenarios);
    const child = spawn(process.execPath, ["--no-env-file", join(root, "parent.ts"), scenarios, join(consumer, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"), join(root, "child.ts")], {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const killGroup = (signal: NodeJS.Signals) => { if (child.pid) { try { process.kill(-child.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } } };
    let stdout = "", stderr = "";
    child.stdout!.on("data", bytes => { stdout += bytes.toString(); if (stdout.length > 200_000) killGroup("SIGKILL"); });
    child.stderr!.on("data", bytes => { stderr += bytes.toString(); if (stderr.length > 200_000) killGroup("SIGKILL"); });
    const exited = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const timer = setTimeout(() => killGroup("SIGTERM"), 40_000);
    const hardTimer = setTimeout(() => killGroup("SIGKILL"), 43_000);
    try {
      const exit = await exited;
      expect(exit, stderr).toBe(0);
      expect(stdout).not.toContain("SYNTHETIC_"); expect(stderr).not.toContain("SYNTHETIC_");
      const receipt = JSON.parse(stdout);
      expect(receipt.rows.map((row: { mode: string }) => row.mode)).toEqual(["rotate", "api-key-env", "logout", "denied", "disconnect", "terminate"]);
      expect(receipt.networkAttempts).toBe(0);
      console.log(JSON.stringify({ filesCompared, receipt, sandbox }));
    } finally { clearTimeout(timer); clearTimeout(hardTimer); killGroup("SIGKILL"); await exited; }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 50_000);
