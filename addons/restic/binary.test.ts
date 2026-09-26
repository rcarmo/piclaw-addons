import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  INSTALL_CONFIRMATION,
  RELEASES,
  RESTIC_VERSION,
  inspectBinary,
  installManaged,
  managedPath,
  resolveBinary,
  selectedRelease,
  type InstallDependencies,
  type Release,
} from "./binary.ts";
import type { RunOptions } from "./contracts.ts";
import { runRestic } from "./runner.ts";

const REQUIRED_BACKENDS = ["local", "sftp", "s3", "azure"];

function temporaryDirectory(prefix = "restic-binary-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureRelease(archive: Uint8Array, binary: Uint8Array): Release {
  return {
    asset: "restic_0.18.1_linux_amd64.bz2",
    archiveSha256: sha256(archive),
    binarySha256: sha256(binary),
  };
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function writeFakeCli(dir: string, name: string, version: string, backends = REQUIRED_BACKENDS): string {
  const path = join(dir, name);
  const options = `${backends.map((backend) => `${backend}.connections = 5`).join("\n")}\n`;
  writeFileSync(path, `#!${process.execPath}
if (process.env.PICLAW_RESTIC_AMBIENT_SENTINEL) process.exit(93);
const command = process.argv[2];
if (command === "version") {
  console.log(${JSON.stringify(`restic ${version} compiled with go1.24 on linux/amd64`)});
  process.exit(0);
}
if (command === "options") {
  process.stdout.write(${JSON.stringify(options)});
  process.exit(0);
}
process.exit(2);
`, { mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

test("test preload confines temporary state to the disposable filesystem", () => {
  expect(process.env.PICLAW_TEST_FS_ISOLATION_ACTIVE).toBe("1");
  const root = realpathSync(process.env.PICLAW_TEST_FS_ISOLATION_ROOT!);
  const temporaryRoot = realpathSync(tmpdir());
  expect(resolve(temporaryRoot).startsWith(`${resolve(root)}${sep}`)).toBe(true);
});

test("release metadata is pinned for Linux x64 and arm64", () => {
  expect(RESTIC_VERSION).toBe("0.18.1");
  expect(selectedRelease("linux", "x64")).toEqual({
    asset: "restic_0.18.1_linux_amd64.bz2",
    archiveSha256: "680838f19d67151adba227e1570cdd8af12c19cf1735783ed1ba928bc41f363d",
    binarySha256: "01143daba61a1dc8afb0cb3d03ba83e6b118f55b6b146b27473a09efc3df13d6",
  });
  expect(selectedRelease("linux", "arm64")).toEqual({
    asset: "restic_0.18.1_linux_arm64.bz2",
    archiveSha256: "87f53fddde38764095e9c058a3b31834052c37e5826d2acf34e18923c006bd45",
    binarySha256: "f04a6bf766a33fba44b5be068e29091259dda5ef37f1e68ba9a8e0cda053120e",
  });
  expect(RELEASES).toEqual({
    "linux-x64": selectedRelease("linux", "x64"),
    "linux-arm64": selectedRelease("linux", "arm64"),
  });
});

test("managed releases reject unsupported operating systems and architectures", () => {
  expect(() => selectedRelease("darwin", "x64")).toThrow("available for Linux x64/arm64");
  expect(() => selectedRelease("linux", "riscv64")).toThrow("available for Linux x64/arm64");
});

test("missing confirmation refuses installation before any network request", async () => {
  const stateDir = temporaryDirectory();
  let fetches = 0;
  try {
    await expect(installManaged(stateDir, "INSTALL RESTIC", undefined, {
      fetchArchive: async () => {
        fetches++;
        throw new Error("network must not be reached");
      },
    })).rejects.toThrow("Explicit verified Restic installation confirmation required");
    expect(fetches).toBe(0);
    expect(existsSync(join(stateDir, "bin"))).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an archive checksum mismatch is never unpacked or executed", async () => {
  const stateDir = temporaryDirectory();
  const expectedArchive = Buffer.from("reviewed archive");
  const binary = Buffer.from("reviewed executable");
  let unpacks = 0;
  let inspections = 0;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(expectedArchive, binary),
      fetchArchive: async () => Buffer.from("tampered archive"),
      unpack: async () => {
        unpacks++;
        return binary;
      },
      inspect: async (path) => {
        inspections++;
        return { path, version: "restic 0.18.1", backends: REQUIRED_BACKENDS };
      },
    })).rejects.toThrow("archive checksum mismatch");
    expect(unpacks).toBe(0);
    expect(inspections).toBe(0);
    expect(existsSync(managedPath(stateDir))).toBe(false);
    expect(existsSync(join(stateDir, "bin", ".install-lock"))).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an extracted executable checksum mismatch is never executed", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("reviewed archive");
  const binary = Buffer.from("reviewed executable");
  let inspections = 0;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(archive, binary),
      fetchArchive: async () => archive,
      unpack: async () => Buffer.from("tampered executable"),
      inspect: async (path) => {
        inspections++;
        return { path, version: "restic 0.18.1", backends: REQUIRED_BACKENDS };
      },
    })).rejects.toThrow("executable checksum mismatch");
    expect(inspections).toBe(0);
    expect(existsSync(managedPath(stateDir))).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a verified install atomically replaces the binary and writes a private receipt", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("fixture bzip archive");
  const binary = Buffer.from("fixture restic executable");
  const release = fixtureRelease(archive, binary);
  const target = managedPath(stateDir);
  const binDir = dirname(target);
  mkdirSync(binDir, { recursive: true, mode: 0o755 });
  writeFileSync(target, "previous executable", { mode: 0o700 });

  const dependencies: InstallDependencies = {
    release,
    fetchArchive: async (url, signal) => {
      expect(url).toBe(`https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${release.asset}`);
      expect(signal.aborted).toBe(false);
      return archive;
    },
    unpack: async (archivePath, signal) => {
      expect(signal.aborted).toBe(false);
      expect(readFileSync(archivePath)).toEqual(archive);
      expect(fileMode(archivePath)).toBe(0o600);
      return binary;
    },
    inspect: async (candidate) => {
      expect(readFileSync(candidate)).toEqual(binary);
      expect(fileMode(candidate)).toBe(0o700);
      expect(readFileSync(target, "utf8")).toBe("previous executable");
      return { path: candidate, version: "restic 0.18.1", backends: [...REQUIRED_BACKENDS] };
    },
  };

  try {
    const installed = await installManaged(stateDir, INSTALL_CONFIRMATION, undefined, dependencies);
    expect(installed).toMatchObject({
      path: target,
      version: "restic 0.18.1",
      backends: REQUIRED_BACKENDS,
      managed: true,
      sha256: release.binarySha256,
    });
    expect(readFileSync(target)).toEqual(binary);
    expect(fileMode(target)).toBe(0o700);
    expect(fileMode(binDir)).toBe(0o700);

    const receiptPath = join(binDir, "receipt.json");
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(receipt).toMatchObject({
      version: RESTIC_VERSION,
      asset: release.asset,
      archiveSha256: release.archiveSha256,
      binarySha256: release.binarySha256,
    });
    expect(Number.isNaN(Date.parse(receipt.installedAt))).toBe(false);
    expect(fileMode(receiptPath)).toBe(0o600);
    expect(readdirSync(binDir).sort()).toEqual([target.split(sep).at(-1)!, "receipt.json"].sort());
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a network failure preserves the previous managed binary", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("archive");
  const binary = Buffer.from("new executable");
  const target = managedPath(stateDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "previous executable", { mode: 0o700 });
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(archive, binary),
      fetchArchive: async () => { throw new Error("offline"); },
    })).rejects.toThrow("offline");
    expect(readFileSync(target, "utf8")).toBe("previous executable");
    expect(fileMode(target)).toBe(0o700);
    expect(existsSync(join(dirname(target), ".install-lock"))).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a probe failure preserves the previous managed binary", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("archive");
  const binary = Buffer.from("new executable");
  const target = managedPath(stateDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "previous executable", { mode: 0o700 });
  let probes = 0;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(archive, binary),
      fetchArchive: async () => archive,
      unpack: async () => binary,
      inspect: async (candidate) => {
        probes++;
        expect(readFileSync(candidate)).toEqual(binary);
        expect(readFileSync(target, "utf8")).toBe("previous executable");
        throw new Error("probe failed");
      },
    })).rejects.toThrow("probe failed");
    expect(probes).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("previous executable");
    expect(existsSync(join(dirname(target), "receipt.json"))).toBe(false);
    expect(readdirSync(dirname(target))).toEqual([target.split(sep).at(-1)!]);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("cancellation reaches the installer and preserves the previous binary", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("archive");
  const binary = Buffer.from("new executable");
  const target = managedPath(stateDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "previous executable", { mode: 0o700 });
  const controller = new AbortController();
  let fetchStarted = false;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, controller.signal, {
      release: fixtureRelease(archive, binary),
      fetchArchive: async (_url, signal) => {
        fetchStarted = true;
        controller.abort();
        expect(signal.aborted).toBe(true);
        signal.throwIfAborted();
        return archive;
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchStarted).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("previous executable");
    expect(existsSync(join(dirname(target), ".install-lock"))).toBe(false);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("an existing install lock prevents a second installation", async () => {
  const stateDir = temporaryDirectory();
  const archive = Buffer.from("archive");
  const binary = Buffer.from("binary");
  const lock = join(stateDir, "bin", ".install-lock");
  mkdirSync(lock, { recursive: true });
  let fetches = 0;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(archive, binary),
      fetchArchive: async () => {
        fetches++;
        return archive;
      },
    })).rejects.toThrow("installation already running or interrupted");
    expect(fetches).toBe(0);
    expect(existsSync(lock)).toBe(true);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("a symlinked managed install directory is rejected", async () => {
  const root = temporaryDirectory();
  const stateDir = join(root, "state");
  const outside = join(root, "symlink-target");
  mkdirSync(stateDir);
  mkdirSync(outside);
  symlinkSync(outside, join(stateDir, "bin"), "dir");
  let fetches = 0;
  try {
    await expect(installManaged(stateDir, INSTALL_CONFIRMATION, undefined, {
      release: fixtureRelease(Buffer.from("archive"), Buffer.from("binary")),
      fetchArchive: async () => {
        fetches++;
        return Buffer.from("archive");
      },
    })).rejects.toThrow("must not contain symlinks");
    expect(fetches).toBe(0);
    expect(readdirSync(outside)).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolveBinary rejects a managed executable with the wrong pinned hash before execution", async () => {
  const stateDir = temporaryDirectory();
  const target = managedPath(stateDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, "not the reviewed Restic binary", { mode: 0o700 });
  let executions = 0;
  try {
    await expect(resolveBinary("managed", stateDir, async () => {
      executions++;
      return { code: 0, stdout: "restic 0.18.1\n", stderr: "", durationMs: 0 };
    })).rejects.toThrow("Managed Restic integrity check failed");
    expect(executions).toBe(0);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("inspectBinary accepts a real custom CLI and passes only the safe environment", async () => {
  const dir = temporaryDirectory();
  const cli = writeFakeCli(dir, "fake-restic", "0.18.1");
  const ambientKey = "PICLAW_RESTIC_AMBIENT_SENTINEL";
  const previousAmbient = process.env[ambientKey];
  const observedEnvironments: Array<Record<string, string>> = [];
  process.env[ambientKey] = "must-not-reach-restic";
  try {
    const result = await inspectBinary(cli, async (options: RunOptions) => {
      observedEnvironments.push({ ...options.env });
      return runRestic(options);
    });
    expect(result).toEqual({
      path: cli,
      version: "restic 0.18.1",
      backends: REQUIRED_BACKENDS,
    });
    expect(observedEnvironments).toHaveLength(2);
    for (const env of observedEnvironments) {
      expect(env).toEqual({ PATH: process.env.PATH || "/usr/bin:/bin" });
      expect(env[ambientKey]).toBeUndefined();
    }
  } finally {
    if (previousAmbient === undefined) delete process.env[ambientKey];
    else process.env[ambientKey] = previousAmbient;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectBinary rejects an old custom CLI", async () => {
  const dir = temporaryDirectory();
  try {
    const cli = writeFakeCli(dir, "old-restic", "0.18.0");
    await expect(inspectBinary(cli)).rejects.toThrow("Restic 0.18.1 or newer is required");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectBinary rejects a custom CLI without Azure support", async () => {
  const dir = temporaryDirectory();
  try {
    const cli = writeFakeCli(dir, "no-azure-restic", "0.18.1", ["local", "sftp", "s3"]);
    await expect(inspectBinary(cli)).rejects.toThrow("required backend support: azure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const publicInstallE2e = process.env.PICLAW_RESTIC_INSTALL_E2E === "1" && process.env.PICLAW_E2E_DISPOSABLE === "1"
  ? test
  : test.skip;

publicInstallE2e("downloads, installs, and resolves the pinned public Restic release", async () => {
  const stateDir = temporaryDirectory("restic-public-install-");
  try {
    const installed = await installManaged(stateDir, INSTALL_CONFIRMATION);
    expect(installed).toMatchObject({
      path: managedPath(stateDir),
      version: `restic ${RESTIC_VERSION}`,
      managed: true,
      sha256: selectedRelease().binarySha256,
    });
    expect(readFileSync(installed.path)).toEqual(readFileSync(managedPath(stateDir)));
    const resolvedBinary = await resolveBinary("managed", stateDir);
    expect(resolvedBinary).toMatchObject({
      path: managedPath(stateDir),
      version: `restic ${RESTIC_VERSION}`,
      backends: REQUIRED_BACKENDS,
      managed: true,
    });
    expect(realpathSync(resolvedBinary.path)).toBe(resolvedBinary.path);
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}, 180_000);
