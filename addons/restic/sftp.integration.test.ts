import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, createConnection } from "node:net";
import { userInfo, tmpdir } from "node:os";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { ResticService } from "./service.ts";
import { defaultJobConfig } from "./job-config.ts";

const enabled = process.env.PICLAW_RESTIC_SFTP === "1" && process.env.PICLAW_E2E_DISPOSABLE === "1";
const integration = enabled ? test : test.skip;

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate an SFTP test port");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => { socket.destroy(); resolve(ready); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(100, () => finish(false));
  });
}

async function startSshd(config: string, port: number, pidFile: string) {
  const child = spawn("sudo", ["-n", "/usr/sbin/sshd", "-D", "-e", "-f", config], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer | string) => { stderr += String(chunk); });
  try {
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`sshd exited before readiness: ${stderr}`);
      if (await canConnect(port)) return child;
      await Bun.sleep(50);
    }
    throw new Error(`sshd did not become ready: ${stderr}`);
  } catch (error) {
    await stopSshd(child, pidFile);
    throw error;
  }
}

async function stopSshd(child: ReturnType<typeof spawn>, pidFile: string): Promise<void> {
  const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
  if (/^\d+$/.test(pid)) {
    try { execFileSync("sudo", ["-n", "kill", "-TERM", pid], { stdio: "ignore" }); } catch {}
  }
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      Bun.sleep(5_000),
    ]);
  }
  if (child.exitCode === null && /^\d+$/.test(pid)) {
    try { execFileSync("sudo", ["-n", "kill", "-KILL", pid], { stdio: "ignore" }); } catch {}
  }
  if (child.exitCode === null) child.kill("SIGKILL");
}

function generateKey(path: string, comment: string): void {
  execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", path], {
    stdio: "ignore",
  });
}

integration("real SFTP init, backup/list/check/restore and strict host-key rejection", async () => {
  if (!existsSync("/usr/sbin/sshd")) throw new Error("SFTP integration requires /usr/sbin/sshd");
  const username = userInfo().username;
  const root = mkdtempSync(join(tmpdir(), "restic-sftp-integration-"));
  const keys = join(root, "keys");
  mkdirSync(keys, { mode: 0o700 });
  const source = join(root, "source");
  const repository = join(root, "repository");
  mkdirSync(source);
  mkdirSync(repository);
  writeFileSync(join(source, "note.txt"), "SFTP restore fixture\n");

  const clientKey = join(keys, "client");
  const hostKey = join(keys, "host");
  const wrongHostKey = join(keys, "wrong-host");
  const authorizedKeys = join(keys, "authorized_keys");
  const configPath = join(keys, "sshd_config");
  const pidFile = join(keys, "sshd.pid");
  generateKey(clientKey, "restic-sftp-client-fixture");
  generateKey(hostKey, "restic-sftp-host-fixture");
  generateKey(wrongHostKey, "restic-sftp-wrong-host-fixture");
  writeFileSync(authorizedKeys, readFileSync(`${clientKey}.pub`, "utf8"), { mode: 0o600 });
  chmodSync(authorizedKeys, 0o600);

  const port = await unusedLoopbackPort();
  writeFileSync(configPath, [
    `Port ${port}`,
    "ListenAddress 127.0.0.1",
    `HostKey ${hostKey}`,
    `PidFile ${pidFile}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    `AllowUsers ${username}`,
    "PubkeyAuthentication yes",
    "StrictModes no", // Test-only authorized_keys lives beneath the isolated /tmp root.
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "UsePAM yes",
    "PermitRootLogin no",
    "PrintMotd no",
    "Subsystem sftp internal-sftp",
    "LogLevel ERROR",
    "",
  ].join("\n"), { mode: 0o600 });

  let sshd: ReturnType<typeof spawn> | undefined;
  const secrets = new Map<string, string>();
  const paths = {
    sources: [{ name: "workspace", path: source }],
    stateDir: join(root, "state"),
    stageDir: join(root, "stage"),
    cacheDir: join(root, "cache"),
  };
  try {
    sshd = await startSshd(configPath, port, pidFile);
    const knownHosts = execFileSync("/usr/bin/ssh-keyscan", ["-T", "5", "-p", String(port), "127.0.0.1"], { encoding: "utf8" });
    if (!knownHosts.includes(`[127.0.0.1]:${port}`)) throw new Error("ssh-keyscan did not return the ephemeral host key");
    secrets.set("restic/test-password", "disposable-restic-sftp-password");
    secrets.set("ssh/test-private-key", readFileSync(clientKey, "utf8"));
    secrets.set("ssh/test-known-hosts", knownHosts);

    const service = new ResticService({
      paths,
      resolveSecret: async (ref) => secrets.get(ref) ?? "",
    });
    const config = {
      ...defaultJobConfig(),
        binary: process.env.PICLAW_RESTIC_TEST_BINARY || "restic",
      repository: {
        backend: "sftp" as const,
        host: "127.0.0.1",
        port,
        user: username,
        path: repository,
        privateKeyRef: "ssh/test-private-key",
        knownHostsRef: "ssh/test-known-hosts",
      },
      passwordRef: "restic/test-password",
    };
    try {
      await service.setConfig(config);
      await service.execute("init", { confirmation: "INITIALISE REPOSITORY" });
      expect((await service.execute("test") as { version: number }).version).toBeGreaterThan(0);

      const backup = await service.execute("backup") as { status: string; snapshotId?: string };
      expect(backup.status).toBe("success");
      expect(backup.snapshotId).toMatch(/^[a-f0-9]{64}$/);

      const snapshots = await service.execute("snapshots") as Array<{ id: string }>;
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]?.id).toBe(backup.snapshotId!);
      await expect(service.execute("check")).resolves.toMatchObject({ checked: expect.any(String) });

      const target = join(root, "restore-target");
      mkdirSync(target);
      const restored = await service.execute("restore", {
        snapshot: snapshots[0]?.id,
        target,
        confirmation: "RESTORE TO EMPTY DIRECTORY",
      }) as { restored: string };
      expect(readFileSync(join(restored.restored, "workspace", "note.txt"), "utf8")).toBe("SFTP restore fixture\n");

      const wrongPublicKey = readFileSync(`${wrongHostKey}.pub`, "utf8").trim();
      secrets.set("ssh/test-known-hosts", `[127.0.0.1]:${port} ${wrongPublicKey}\n`);
      await expect(service.execute("test")).rejects.toThrow(/host key verification failed/i);
    } finally {
      service.stop();
    }
  } finally {
    if (sshd) await stopSshd(sshd, pidFile);
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
