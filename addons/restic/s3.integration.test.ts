import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunOptions } from "./contracts.ts";
import { defaultJobConfig } from "./job-config.ts";
import { runRestic } from "./runner.ts";
import { ResticService } from "./service.ts";

const enabled = process.env.PICLAW_RESTIC_S3 === "1" && process.env.PICLAW_E2E_DISPOSABLE === "1";
const integration = enabled ? test : test.skip;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 15_000 }).trim();
}

function removeContainer(name: string): void {
  try {
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", timeout: 15_000 });
  } catch {
    // The --rm container may already have exited and removed itself.
  }
}

async function waitForRustfs(name: string, port: number): Promise<void> {
  let lastError = "no HTTP response";
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        redirect: "manual",
        signal: AbortSignal.timeout(250),
      });
      await response.body?.cancel();
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    const running = docker(["inspect", "--format", "{{.State.Running}}", name]);
    if (running !== "true") {
      throw new Error(`RustFS exited before readiness:\n${docker(["logs", name])}`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`RustFS did not become ready: ${lastError}\n${docker(["logs", name])}`);
}

integration("real S3 init, backup, snapshots, check, and restore through verified HTTPS", async () => {
  if (!Bun.which("docker")) throw new Error("S3 integration requires docker");
  if (!Bun.which("openssl")) throw new Error("S3 integration requires openssl");
  if (!Bun.which("restic")) throw new Error("S3 integration requires restic");

  const root = mkdtempSync(join(tmpdir(), "restic-s3-integration-"));
  const cert = join(root, "cert.pem");
  const key = join(root, "key.pem");
  const source = join(root, "source");
  const containerName = `piclaw-restic-s3-${process.pid}-${randomUUID()}`;
  const accessKey = `restic-test-${randomUUID()}`;
  const secretKey = `disposable-${randomUUID()}-${randomUUID()}`;
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let service: ResticService | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  mkdirSync(source);
  writeFileSync(join(source, "note.txt"), "S3 restore fixture\n");

  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
      "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1",
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,digitalSignature",
      "-addext", "extendedKeyUsage=serverAuth",
    ], { stdio: "ignore", timeout: 15_000 });

    docker([
      "run", "--detach", "--rm", "--pull=never", "--name", containerName,
      "--publish", "127.0.0.1::9000",
      "--env", `RUSTFS_ACCESS_KEY=${accessKey}`,
      "--env", `RUSTFS_SECRET_KEY=${secretKey}`,
      "--env", "RUSTFS_CONSOLE_ENABLE=false",
      "rustfs/rustfs:latest",
    ]);
    const rustfsPort = Number(docker([
      "inspect", "--format", "{{(index (index .NetworkSettings.Ports \"9000/tcp\") 0).HostPort}}",
      containerName,
    ]));
    if (!Number.isInteger(rustfsPort) || rustfsPort < 1 || rustfsPort > 65535) {
      throw new Error("Docker did not assign a RustFS loopback port");
    }
    await waitForRustfs(containerName, rustfsPort);

    proxy = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      async fetch(request) {
        const incoming = new URL(request.url);
        const upstream = new URL(`http://127.0.0.1:${rustfsPort}${incoming.pathname}${incoming.search}`);
        const headers = new Headers(request.headers);
        const signedHost = request.headers.get("host");
        if (!signedHost) return new Response("Missing signed Host header", { status: 400 });
        headers.set("host", signedHost);
        const response = await fetch(upstream, {
          method: request.method,
          headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
          redirect: "manual",
        });
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    });

    const secrets = new Map([
      ["restic/test-password", `disposable-restic-${randomUUID()}`],
      ["s3/test-access-key", accessKey],
      ["s3/test-secret-key", secretKey],
    ]);
    const paths = {
      sources: [{ name: "workspace", path: source }],
      stateDir: join(root, "state"),
      stageDir: join(root, "stage"),
      cacheDir: join(root, "cache"),
    };
    const run = (options: RunOptions) => options.args.length === 1 && options.args[0] === "version"
      ? runRestic(options)
      : runRestic({ ...options, args: ["--cacert", cert, ...options.args] });
    service = new ResticService({
      paths,
      resolveSecret: async (ref) => secrets.get(ref) ?? "",
      run,
    });
    await service.setConfig({
      ...defaultJobConfig(),
        binary: process.env.PICLAW_RESTIC_TEST_BINARY || "restic",
      repository: {
        backend: "s3" as const,
        endpoint: `https://127.0.0.1:${proxy.port}`,
        region: "us-east-1",
        bucket: "restic-test",
        prefix: "",
        accessKeyRef: "s3/test-access-key",
        secretKeyRef: "s3/test-secret-key",
      },
      passwordRef: "restic/test-password",
    });

    // Abort an active Restic process early enough for the test's finally cleanup to run.
    watchdog = setTimeout(() => service?.stop(), 220_000);
    watchdog.unref();

    await service.execute("init", { confirmation: "INITIALISE REPOSITORY" });

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
    expect(existsSync(restored.restored)).toBe(true);
    expect(readFileSync(join(restored.restored, "workspace", "note.txt"), "utf8")).toBe("S3 restore fixture\n");
  } finally {
    if (watchdog) clearTimeout(watchdog);
    service?.stop();
    if (proxy) await proxy.stop(true);
    removeContainer(containerName);
    rmSync(root, { recursive: true, force: true });
  }
}, 240_000);
