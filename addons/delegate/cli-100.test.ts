import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const packageRoot = process.env.PICLAW_DELEGATE_100_PACKAGE;
const archive = process.env.PICLAW_DELEGATE_100_ARCHIVE;
const parentNamespace = process.env.PICLAW_DELEGATE_PARENT_NETNS;
const integration = process.env.PICLAW_E2E_DISPOSABLE === "1" && packageRoot && archive ? test : test.skip;
const integrity = "sha512-/FtbxoSQU/mEv1QnichJjRjqteqaIaMWxmhB4G367+MwZfX7/DI5B9YAg5lqbN7nztFskBEtUSZ+FlmMBECtMw==";

integration("standalone Delegate resolves and runs the exact published Pi 1.0.0 bin under Bun", async () => {
  if (!packageRoot || !archive || !isAbsolute(packageRoot) || !isAbsolute(archive)) throw Error("Explicit absolute package and archive paths required");
  if (process.platform !== "linux" || !parentNamespace || readlinkSync("/proc/self/ns/net") === parentNamespace) throw Error("Separate network namespace required");
  const archiveBytes = readFileSync(archive);
  expect("sha512-" + createHash("sha512").update(archiveBytes).digest("base64")).toBe(integrity);
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  expect(manifest.name).toBe("@earendil-works/pi-coding-agent"); expect(manifest.version).toBe("1.0.0");
  expect(manifest.bin.pi).toBe("dist/bundle/cli.js");
  const bundledFiles = (directory: string): string[] => readdirSync(join(packageRoot, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? bundledFiles(`${directory}/${entry.name}`) : entry.name.endsWith(".js") ? [`${directory}/${entry.name}`] : []);
  const files = ["package.json", ...bundledFiles("dist/bundle").sort()];
  expect(files.length).toBe(74);
  for (const path of files) {
    const unpacked = Bun.spawnSync(["tar", "-xOf", archive, "package/" + path], { stdout: "pipe", stderr: "pipe" });
    expect(unpacked.exitCode, path).toBe(0);
    expect(Buffer.from(unpacked.stdout).equals(readFileSync(join(packageRoot, path))), path).toBe(true);
  }
  const root = mkdtempSync(join(tmpdir(), "delegate-cli100-"));
  try {
    for (const dir of ["addon/compat", "node_modules/@earendil-works", "home", "profile", "workspace", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
    cpSync(join(import.meta.dir, "delegate.ts"), join(root, "addon/delegate.ts"));
    cpSync(join(import.meta.dir, "compat/extension-kv.ts"), join(root, "addon/compat/extension-kv.ts"));
    symlinkSync(packageRoot, join(root, "node_modules/@earendil-works/pi-coding-agent"), "dir");
    writeFileSync(join(root, "resolve.ts"), `import {resolveDelegateCliCommand} from './addon/delegate.ts'; console.log(JSON.stringify(resolveDelegateCliCommand({env:{PATH:'',BUN_INSTALL:'/nonexistent'},execPath:process.execPath})));`);
    const env = { PATH: "/usr/bin:/bin", HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "profile"), TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "home"), XDG_CACHE_HOME: join(root, "home"), PI_OFFLINE: "1", PI_TELEMETRY: "0", NO_COLOR: "1" };
    async function run(args: string[]) {
      const child = Bun.spawn(args, { cwd: join(root, "workspace"), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(code, err).toBe(0); return out;
      } finally { clearTimeout(timer); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
    }
    const cli = JSON.parse(await run([process.execPath, "--no-env-file", join(root, "resolve.ts")]));
    expect(cli.command).toBe(process.execPath);
    expect(cli.argsPrefix).toEqual([resolve(packageRoot, manifest.bin.pi)]);
    expect((await run([cli.command, "--no-env-file", ...cli.argsPrefix, "--offline", "--version"])).trim()).toBe("1.0.0");
    expect(readdirSync(join(root, "profile"))).toEqual([]);
    expect(readdirSync(join(root, "workspace"))).toEqual([]);
    console.log(JSON.stringify({ scope: "packaged-bin-resolution-and-version-only", version: "1.0.0", filesCompared: files.length, integrity, networkNamespace: "separate", providerExecution: "not exercised", authEngineParity: "unqualified" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
