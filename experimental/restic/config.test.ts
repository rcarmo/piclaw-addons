import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, validateConfig, validateRepository, type RepositoryProfile } from "./config.ts";
import { assertBackupPaths, repositoryPlan } from "./repository.ts";

const profiles = [
  { backend: "local", path: "/backups/restic", expectedMount: "/backups" },
  { backend: "sftp", host: "backup.example.test", port: 2222, user: "backup", path: "/srv/restic", privateKeyRef: "ssh/backup", knownHostsRef: "ssh/known-hosts" },
  { backend: "s3", endpoint: "https://s3.example.test:9443", region: "us-east-1", bucket: "backup-bucket", prefix: "smith/daily", accessKeyRef: "s3/access", secretKeyRef: "s3/secret", sessionTokenRef: "s3/session" },
  { backend: "azure", account: "backupaccount", container: "backups", prefix: "smith", accountKeyRef: "azure/account-key" },
] satisfies RepositoryProfile[];
const config = (repository: unknown) => ({ ...defaultConfig(), repository, passwordRef: "restic/password" });

test("defaults have no repository and disable both execution and maintenance", () => {
  expect(validateConfig(defaultConfig())).toEqual(defaultConfig());
  expect(defaultConfig().enabled).toBe(false);
  expect(defaultConfig().retention.enabled).toBe(false);
  const a = defaultConfig(); a.retention.hourly = 1;
  expect(defaultConfig().retention.hourly).toBe(24);
  expect(() => validateConfig({ ...defaultConfig(), enabled: true })).toThrow();
  expect(() => repositoryPlan(defaultConfig())).toThrow("not configured");
});
test("four native profiles map credentials by reference only", () => {
  for (const p of profiles) expect(validateConfig(config(p)).repository).toEqual(p);
  expect(repositoryPlan(config(profiles[0]))).toEqual({ repository: "/backups/restic", environment: {}, credentialRefs: { RESTIC_PASSWORD: "restic/password" } });
  expect(repositoryPlan(config(profiles[1]))).toMatchObject({ repository: "sftp://backup@backup.example.test:2222/srv/restic", ssh: profiles[1] });
  expect(repositoryPlan(config({ ...profiles[1], host: "::1" })).repository).toBe("sftp://backup@[::1]:2222/srv/restic");
  expect(repositoryPlan(config(profiles[2]))).toEqual({ repository: "s3:https://s3.example.test:9443/backup-bucket/smith/daily", environment: { AWS_DEFAULT_REGION: "us-east-1" }, credentialRefs: { RESTIC_PASSWORD: "restic/password", AWS_ACCESS_KEY_ID: "s3/access", AWS_SECRET_ACCESS_KEY: "s3/secret", AWS_SESSION_TOKEN: "s3/session" } });
  expect(repositoryPlan(config(profiles[3]))).toEqual({ repository: "azure:backups:smith", environment: { AZURE_ACCOUNT_NAME: "backupaccount" }, credentialRefs: { RESTIC_PASSWORD: "restic/password", AZURE_ACCOUNT_KEY: "azure/account-key" } });
  expect(repositoryPlan(config({ ...profiles[3], prefix: "" })).repository).toBe("azure:backups:");
});
test("reject shell fields, credential values, unsupported backends and extra properties", () => {
  for (const p of profiles) {
    for (const key of ["password", "secret", "command", "env", "insecureTLS", "sshCommand", "forceUnlock"]) expect(() => validateRepository({ ...p, [key]: "do-not-echo-secret" })).toThrow(/fields/);
  }
  for (const backend of ["rclone", "rsync", "rest", "gcs", null]) expect(() => validateRepository({ backend })).toThrow();
  expect(() => validateConfig({ ...config(profiles[0]), enabled: "false" })).toThrow();
  expect(() => validateConfig({ ...config(profiles[0]), arbitrary: true })).toThrow();
  expect(() => validateConfig({ ...config(profiles[0]), passwordRef: "secret\nvalue" })).toThrow("Invalid Restic encryption password reference");
});
test("encryption and transport credential references must be distinct", () => {
  for (const p of profiles.slice(1)) {
    const transport = Object.keys(p).find(k => k.endsWith("Ref"))!;
    expect(() => validateConfig(config({ ...p, [transport]: "restic/password" }))).toThrow("separate encryption");
  }
});
test("HTTPS endpoints cannot hide credentials, queries, paths or TLS overrides", () => {
  for (const endpoint of ["http://s3.test", "https://user:secret@s3.test", "https://s3.test?token=secret", "https://s3.test/#secret", "https://s3.test/path", "https://s3.test/a/..", "https://s3.test\\evil", "--insecure-tls", "https://s3.test\n"]) {
    expect(() => validateRepository({ ...profiles[2], endpoint })).toThrow("Invalid Restic S3 endpoint");
  }
  expect(validateRepository({ ...profiles[2], endpoint: "https://s3.test/" })).toMatchObject({ endpoint: "https://s3.test" });
});
test("S3 names allow dots and repeated hyphens while Azure retains stricter container rules", () => {
  for (const bucket of ["backup.example", "backup--daily"]) expect(validateRepository({ ...profiles[2], bucket })).toMatchObject({ bucket });
  for (const bucket of ["backup..daily", "127.0.0.1", "-backup", "backup/"]) expect(() => validateRepository({ ...profiles[2], bucket })).toThrow();
  for (const container of ["backup.example", "backup--daily"]) expect(() => validateRepository({ ...profiles[3], container })).toThrow();
});
test("remote fields cannot inject SSH commands or traverse repository prefixes", () => {
  for (const host of ["-oProxyCommand=bad", "example.test;id", "x y", "x\n", "user@host", "host:22", ""]) expect(() => validateRepository({ ...profiles[1], host })).toThrow();
  for (const path of ["relative", "/repo/../root", "/", "/repo;id", "/repo/$(id)", "/repo\n"]) expect(() => validateRepository({ ...profiles[1], path })).toThrow();
  for (const port of [0, 65536, 22.5, "22"]) expect(() => validateRepository({ ...profiles[1], port })).toThrow();
  for (const p of profiles.slice(2)) for (const prefix of ["/root", "../root", "a/../b", "a//b", "a/", "a?x", "a#x"]) expect(() => validateRepository({ ...p, prefix })).toThrow();
  expect(() => validateRepository({ ...profiles[1], knownHostsRef: "" })).toThrow();
});
test("local paths and retention fail closed", () => {
  for (const path of ["relative", "/repo/../root", "/repo\n"]) expect(() => validateRepository({ ...profiles[0], path })).toThrow();
  for (const count of [-1, 1.5, 10001, "24"]) expect(() => validateConfig({ ...config(profiles[0]), retention: { ...defaultConfig().retention, hourly: count } })).toThrow();
  expect(() => validateConfig({ ...config(profiles[0]), retention: { enabled: true, hourly: 0, daily: 0, weekly: 0, monthly: 0 } })).toThrow();
  expect(validateConfig({ ...config(profiles[0]), retention: { ...defaultConfig().retention, enabled: true } }).retention.enabled).toBe(true);
});
test("real-path checks reject source/repository/cache/staging overlap and symlink aliases", () => {
  const root = mkdtempSync(join(tmpdir(), "restic-paths-"));
  try {
    const source = join(root, "source"), repository = join(root, "repository");
    mkdirSync(source); mkdirSync(repository);
    expect(() => assertBackupPaths([source], [repository])).not.toThrow();
    expect(() => assertBackupPaths([source], [source + "-backup"])).not.toThrow();
    for (const path of [source, join(source, "new-repo"), root]) expect(() => assertBackupPaths([source], [path])).toThrow("overlaps");
    const alias = join(root, "alias"); symlinkSync(source, alias);
    expect(() => assertBackupPaths([source], [join(alias, "new-repo")])).toThrow("overlaps");
    expect(() => assertBackupPaths([], [repository])).toThrow();
    expect(() => assertBackupPaths(["relative"], [repository])).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
