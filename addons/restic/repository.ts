import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isIP } from "node:net";
import { validateConfig, type RepositoryProfile } from "./config.ts";

/** Pure execution inputs; no secret lookup, process, repository initialisation or network IO. */
export function repositoryPlan(input: unknown) {
  const config = validateConfig(input);
  if (!config.repository) throw new Error("Restic repository is not configured");
  const p = config.repository;
  const credentials: Record<string, string> = { RESTIC_PASSWORD: config.passwordRef };
  const environment: Record<string, string> = {};
  let repository: string;
  let ssh: Extract<RepositoryProfile, { backend: "sftp" }> | undefined;
  switch (p.backend) {
    case "local": repository = p.path; break;
    case "sftp": {
      const host = isIP(p.host) === 6 ? `[${p.host}]` : p.host;
      repository = `sftp://${p.user}@${host}:${p.port}${p.path}`;
      // Future runner must materialise key/known-hosts files and enforce StrictHostKeyChecking=yes.
      // Do not execute SFTP until that transport is implemented and tested.
      ssh = p;
      break;
    }
    case "s3":
      repository = `s3:${p.endpoint}/${p.bucket}${p.prefix ? `/${p.prefix}` : ""}`;
      environment.AWS_DEFAULT_REGION = p.region;
      credentials.AWS_ACCESS_KEY_ID = p.accessKeyRef;
      credentials.AWS_SECRET_ACCESS_KEY = p.secretKeyRef;
      if (p.sessionTokenRef) credentials.AWS_SESSION_TOKEN = p.sessionTokenRef;
      break;
    case "azure":
      repository = `azure:${p.container}:${p.prefix}`;
      environment.AZURE_ACCOUNT_NAME = p.account;
      credentials.AZURE_ACCOUNT_KEY = p.accountKeyRef;
      break;
  }
  return { repository, environment, credentialRefs: credentials, ...(ssh ? { ssh } : {}) };
}

function canonical(path: string): string {
  if (!isAbsolute(path)) throw new Error("Restic paths must be absolute");
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new Error("Cannot resolve Restic path");
  return join(canonical(parent), relative(parent, path));
}
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
/** Check real paths (including existing symlink ancestors), not string prefixes.
 * The runner must recheck at execution and separately verify expected mount identity.
 */
export function assertBackupPaths(sources: string[], excludedPaths: string[]): void {
  if (!sources.length) throw new Error("Restic backup source is required");
  for (const source of sources.map(canonical)) {
    for (const excluded of excludedPaths.map(canonical)) {
      if (contains(source, excluded) || contains(excluded, source)) throw new Error("Restic repository/cache/staging overlaps a backup source");
    }
  }
}
