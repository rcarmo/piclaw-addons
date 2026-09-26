import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareTransport, runRestic } from "./runner.ts";

const BUN = Bun.which("bun") || process.execPath;

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeScript(dir: string, name: string, source: string): string {
  const path = join(dir, name);
  writeFileSync(path, source);
  return path;
}

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("prepareTransport allowlists cloud env and resolves credentials explicitly", async () => {
  const privateDir = makeTempDir("restic-cloud-private-");
  try {
    const resolved = new Map([
      ["restic/password", "resolved-password"],
      ["s3/access", "resolved-access"],
      ["s3/secret", "resolved-secret"],
      ["s3/session", "resolved-session"],
    ]);
    const transport = await prepareTransport({
    enabled: true,
    repository: {
      backend: "s3",
      endpoint: "https://s3.example.test",
      region: "us-east-1",
      bucket: "backup.example",
      prefix: "smith/daily",
      accessKeyRef: "s3/access",
      secretKeyRef: "s3/secret",
      sessionTokenRef: "s3/session",
    },
    passwordRef: "restic/password",
      retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 6 },
    }, privateDir, async (ref) => resolved.get(ref) ?? "missing");

    expect(transport.args).toEqual(["--repo", "s3:https://s3.example.test/backup.example/smith/daily"]);
    expect(transport.env).toEqual({
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      AWS_DEFAULT_REGION: "us-east-1",
      RESTIC_PASSWORD: "resolved-password",
      AWS_ACCESS_KEY_ID: "resolved-access",
      AWS_SECRET_ACCESS_KEY: "resolved-secret",
      AWS_SESSION_TOKEN: "resolved-session",
    });
    expect(Object.keys(transport.env).sort()).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_DEFAULT_REGION",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      ...(process.env.PATH ? ["PATH"] : []),
      "RESTIC_PASSWORD",
    ]);
    expect([...transport.secrets].sort()).toEqual([
      "resolved-access",
      "resolved-password",
      "resolved-secret",
      "resolved-session",
    ]);
    transport.cleanup();
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
});

test("prepareTransport materialises strict SFTP files and cleanup removes them", async () => {
  const privateDir = makeTempDir("restic-sftp-private-");
  try {
    const values = new Map([
      ["restic/password", "restic-password"],
      ["ssh/private", "PRIVATE KEY\nline2\n"],
      ["ssh/known-hosts", "backup.example.test ssh-ed25519 AAAATEST\n"],
    ]);
    const transport = await prepareTransport({
      enabled: true,
      repository: {
        backend: "sftp",
        host: "backup.example.test",
        port: 2222,
        user: "backup",
        path: "/srv/restic",
        privateKeyRef: "ssh/private",
        knownHostsRef: "ssh/known-hosts",
      },
      passwordRef: "restic/password",
      retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 6 },
    }, privateDir, async (ref) => values.get(ref) ?? "missing");

    expect(transport.args[0]).toBe("--repo");
    expect(transport.args[1]).toBe("sftp://backup@backup.example.test:2222/srv/restic");
    expect(transport.args[2]).toBe("-o");
    const commandArg = transport.args[3];
    expect(commandArg.startsWith("sftp.command=ssh ")).toBe(true);
    expect(commandArg).toContain("StrictHostKeyChecking=yes");
    expect(commandArg).toContain("IdentitiesOnly=yes");
    expect(commandArg).toContain("BatchMode=yes");
    expect(commandArg).toContain("-F /dev/null");
    expect(commandArg).not.toContain("backup.example.test:2222");
    expect(transport.env).toEqual({
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      RESTIC_PASSWORD: "restic-password",
    });

    const entries = readdirSync(privateDir);
    expect(entries).toHaveLength(1);
    const materializedDir = join(privateDir, entries[0]!);
    const keyPath = join(materializedDir, "id");
    const knownHostsPath = join(materializedDir, "known_hosts");
    expect(mode(materializedDir)).toBe(0o700);
    expect(mode(keyPath)).toBe(0o600);
    expect(mode(knownHostsPath)).toBe(0o600);
    expect(readFileSync(keyPath, "utf8")).toBe("PRIVATE KEY\nline2\n");
    expect(readFileSync(knownHostsPath, "utf8")).toBe("backup.example.test ssh-ed25519 AAAATEST\n");
    expect(commandArg).toContain(`'UserKnownHostsFile=${knownHostsPath}'`);
    expect(commandArg).toContain(`-i '${keyPath}'`);
    expect(transport.secrets).toContain("PRIVATE KEY\nline2\n");
    expect(transport.secrets).toContain("backup.example.test ssh-ed25519 AAAATEST\n");

    transport.cleanup();
    expect(existsSync(materializedDir)).toBe(false);
    transport.cleanup();
  } finally {
    rmSync(privateDir, { recursive: true, force: true });
  }
});

test("runRestic redacts success output", async () => {
  const dir = makeTempDir("restic-run-success-");
  try {
    const script = writeScript(dir, "echo-secret.ts", `
      const secret = process.argv[2];
      process.stdout.write('stdout=' + secret + '\\n');
      process.stderr.write('stderr=' + secret + '\\n');
      process.exit(0);
    `);
    const result = await runRestic({
      binary: BUN,
      args: [script, "hunter2"],
      env: { PATH: process.env.PATH || "" },
      redact: ["hunter2"],
      timeoutMs: 5_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stderr).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("hunter2");
    expect(result.stderr).not.toContain("hunter2");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRestic returns nonzero exits with captured output", async () => {
  const dir = makeTempDir("restic-run-nonzero-");
  try {
    const script = writeScript(dir, "exit-nonzero.ts", `
      process.stdout.write('partial output\\n');
      process.stderr.write('problem details\\n');
      process.exit(7);
    `);
    const result = await runRestic({
      binary: BUN,
      args: [script],
      env: { PATH: process.env.PATH || "" },
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      code: 7,
      stdout: "partial output\n",
      stderr: "problem details\n",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRestic rejects when stdout exceeds the byte cap", async () => {
  const dir = makeTempDir("restic-run-overflow-");
  try {
    const script = writeScript(dir, "overflow.ts", `
      process.stdout.write('x'.repeat(2048));
      await Bun.sleep(200);
    `);
    await expect(runRestic({
      binary: BUN,
      args: [script],
      env: { PATH: process.env.PATH || "" },
      maxOutputBytes: 128,
      timeoutMs: 5_000,
    })).rejects.toThrow("stdout exceeded 128 bytes");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRestic abort kills the process tree", async () => {
  const dir = makeTempDir("restic-run-abort-");
  try {
    const marker = join(dir, "orphan-marker.txt");
    const grandchild = writeScript(dir, "grandchild.ts", `
      import { writeFileSync } from 'node:fs';
      await Bun.sleep(700);
      writeFileSync(process.argv[2], 'orphan');
    `);
    const parent = writeScript(dir, "parent.ts", `
      import { spawn } from 'node:child_process';
      spawn(process.execPath, [process.argv[3], process.argv[2]], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `);
    const controller = new AbortController();
    const pending = runRestic({
      binary: BUN,
      args: [parent, marker, grandchild],
      env: { PATH: process.env.PATH || "" },
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 150);
    await expect(pending).rejects.toMatchObject({ name: "AbortError", message: "Aborted" });
    await Bun.sleep(1_000);
    expect(existsSync(marker)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runRestic sanitizes missing binary failures", async () => {
  const dir = makeTempDir("restic-run-missing-");
  try {
    await expect(runRestic({
      binary: join(dir, "missing-restic"),
      args: [],
      env: { PATH: process.env.PATH || "" },
      redact: ["secret-value"],
      timeoutMs: 5_000,
    })).rejects.toThrow("Failed to start Restic binary");
    await expect(runRestic({
      binary: join(dir, "missing-restic"),
      args: [],
      env: { PATH: process.env.PATH || "" },
      redact: ["secret-value"],
      timeoutMs: 5_000,
    })).rejects.toThrow("not found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("signal termination cannot be reported as a successful exit", async () => {
  const r=await runRestic({binary:process.execPath,args:['-e','process.kill(process.pid,"SIGTERM")'],env:{PATH:process.env.PATH||''},timeoutMs:2000});
  expect(r.code).not.toBe(0);
});

test("timeout rejects and kills a child ignoring SIGTERM",async()=>{
  await expect(runRestic({binary:process.execPath,args:['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],env:{PATH:process.env.PATH||''},timeoutMs:80})).rejects.toThrow('timed out');
});
