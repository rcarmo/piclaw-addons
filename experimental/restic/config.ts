/** Restic configuration contains keychain names only, never credential values. */
import { isAbsolute, normalize, posix } from "node:path";
import { isIP } from "node:net";

export type RepositoryProfile =
  | { backend: "local"; path: string; expectedMount?: string }
  | { backend: "sftp"; host: string; port: number; user: string; path: string; privateKeyRef: string; knownHostsRef: string }
  | { backend: "s3"; endpoint: string; region: string; bucket: string; prefix: string; accessKeyRef: string; secretKeyRef: string; sessionTokenRef?: string }
  | { backend: "azure"; account: string; container: string; prefix: string; accountKeyRef: string };
export interface ResticConfig {
  enabled: boolean;
  repository: RepositoryProfile | null;
  passwordRef: string;
  retention: { enabled: boolean; hourly: number; daily: number; weekly: number; monthly: number };
}
export function defaultConfig(): ResticConfig {
  return { enabled: false, repository: null, passwordRef: "", retention: { enabled: false, hourly: 24, daily: 7, weekly: 4, monthly: 6 } };
}
// Errors name fields only: an invalid value might accidentally contain a secret.
function invalid(field: string): never { throw new Error(`Invalid Restic ${field}`); }
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid(`${field} fields`);
  return result;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) invalid(field);
  return value;
}
function match(value: unknown, pattern: RegExp, field: string): string {
  const result = text(value, field);
  if (!pattern.test(result)) invalid(field);
  return result;
}
function ref(value: unknown, field: string): string { return match(value, /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/, field); }
function optionalRef(value: unknown, field: string): string | undefined { return value === undefined ? undefined : ref(value, field); }
function absolutePath(value: unknown, field: string): string {
  const result = text(value, field);
  if (!isAbsolute(result) || normalize(result) !== result) invalid(field);
  return result;
}
function prefix(value: unknown): string {
  if (value === "") return "";
  const result = match(value, /^[A-Za-z0-9._/-]+$/, "prefix");
  if (result.split("/").some(part => !part || part === "." || part === "..")) invalid("prefix");
  return result;
}
function bucket(value: unknown, field: string): string {
  const result = match(value, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, field);
  if (result.includes("--")) invalid(field);
  return result;
}
function s3Bucket(value: unknown): string {
  const result = match(value, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, "S3 bucket");
  if (result.includes("..") || isIP(result)) invalid("S3 bucket");
  return result;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) invalid(field);
  return value as number;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(field);
  return value;
}
export function validateRepository(value: unknown): RepositoryProfile {
  const common = object(value, ["backend", "path", "expectedMount", "host", "port", "user", "privateKeyRef", "knownHostsRef", "endpoint", "region", "bucket", "prefix", "accessKeyRef", "secretKeyRef", "sessionTokenRef", "account", "container", "accountKeyRef"], "repository");
  switch (common.backend) {
    case "local": {
      const p = object(value, ["backend", "path", "expectedMount"], "local");
      return { backend: "local", path: absolutePath(p.path, "repository path"), ...(p.expectedMount === undefined ? {} : { expectedMount: absolutePath(p.expectedMount, "expected mount") }) };
    }
    case "sftp": {
      const p = object(value, ["backend", "host", "port", "user", "path", "privateKeyRef", "knownHostsRef"], "SFTP");
      const host = text(p.host, "SFTP host");
      if (!isIP(host) && (host.length > 253 || host.split(".").some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) invalid("SFTP host");
      const path = match(p.path, /^\/[A-Za-z0-9._/-]+$/, "SFTP path");
      if (posix.normalize(path) !== path || path === "/") invalid("SFTP path");
      return { backend: "sftp", host, port: integer(p.port, 1, 65535, "SFTP port"), user: match(p.user, /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, "SFTP user"), path, privateKeyRef: ref(p.privateKeyRef, "SSH private key reference"), knownHostsRef: ref(p.knownHostsRef, "SSH known-hosts reference") };
    }
    case "s3": {
      const p = object(value, ["backend", "endpoint", "region", "bucket", "prefix", "accessKeyRef", "secretKeyRef", "sessionTokenRef"], "S3");
      const endpoint = text(p.endpoint, "S3 endpoint");
      let url: URL;
      try { url = new URL(endpoint); } catch { invalid("S3 endpoint"); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^https:\/\/[^/?#@]+\/?$/.test(endpoint)) invalid("S3 endpoint");
      return { backend: "s3", endpoint: url.origin, region: match(p.region, /^[a-z0-9-]{1,64}$/, "S3 region"), bucket: s3Bucket(p.bucket), prefix: prefix(p.prefix), accessKeyRef: ref(p.accessKeyRef, "S3 access key reference"), secretKeyRef: ref(p.secretKeyRef, "S3 secret key reference"), ...(p.sessionTokenRef === undefined ? {} : { sessionTokenRef: optionalRef(p.sessionTokenRef, "S3 session token reference") }) };
    }
    case "azure": {
      const p = object(value, ["backend", "account", "container", "prefix", "accountKeyRef"], "Azure");
      return { backend: "azure", account: match(p.account, /^[a-z0-9]{3,24}$/, "Azure account"), container: bucket(p.container, "Azure container"), prefix: prefix(p.prefix), accountKeyRef: ref(p.accountKeyRef, "Azure account key reference") };
    }
    default: invalid("backend");
  }
}
export function validateConfig(value: unknown): ResticConfig {
  const c = object(value, ["enabled", "repository", "passwordRef", "retention"], "config");
  const enabled = boolean(c.enabled, "enabled");
  const repository = c.repository === null ? null : validateRepository(c.repository);
  const passwordRef = c.passwordRef === "" && !repository ? "" : ref(c.passwordRef, "encryption password reference");
  if (enabled && !repository) invalid("repository");
  const r = object(c.retention, ["enabled", "hourly", "daily", "weekly", "monthly"], "retention");
  const retention = { enabled: boolean(r.enabled, "retention enabled"), hourly: integer(r.hourly, 0, 10000, "hourly retention"), daily: integer(r.daily, 0, 10000, "daily retention"), weekly: integer(r.weekly, 0, 10000, "weekly retention"), monthly: integer(r.monthly, 0, 10000, "monthly retention") };
  if (retention.enabled && (!repository || !(retention.hourly + retention.daily + retention.weekly + retention.monthly))) invalid("retention");
  if (repository && Object.entries(repository).some(([key, val]) => key.endsWith("Ref") && val === passwordRef)) invalid("separate encryption password reference");
  return { enabled, repository, passwordRef, retention };
}
