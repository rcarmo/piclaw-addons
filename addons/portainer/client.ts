import { getKeychainEntry, listKeychainEntries } from "./compat/keychain.js";
import { buildInjectedExecCommand } from "./compat/keychain.js";
import { createLogger, debugSuppressedError } from "./compat/logger.js";

const log = createLogger("portainer.client");

export type PortainerApiMethod = "GET" | "POST" | "PUT" | "DELETE";
export type PortainerWorkflowName =
  | "endpoint.list"
  | "endpoint.resolve"
  | "endpoint.inspect"
  | "endpoint.ping"
  | "endpoint.docker_info"
  | "endpoint.docker_version"
  | "endpoint.system_df"
  | "stack.list"
  | "stack.resolve"
  | "stack.file"
  | "stack.create_standalone"
  | "stack.update"
  | "stack.pull_and_update"
  | "stack.delete"
  | "container.list"
  | "container.resolve"
  | "container.inspect"
  | "container.compose"
  | "container.start"
  | "container.stop"
  | "container.restart"
  | "container.logs"
  | "container.mounts"
  | "container.exec"
  | "container.upgrade"
  | "container.upgrade_many"
  | "container.delete"
  | "image.list"
  | "image.inspect"
  | "image.pull"
  | "image.delete"
  | "image.prune"
  | "image.update_check"
  | "network.list"
  | "network.inspect"
  | "network.create"
  | "network.delete"
  | "volume.list"
  | "volume.inspect"
  | "volume.create"
  | "volume.delete"
  | "volume.prune";

export interface PortainerApiConfig {
  base_url: string;
  api_token_keychain: string;
  allow_insecure_tls: boolean;
}

export interface PortainerApiAuth {
  base_url: string | null;
  token: string;
}

export interface PortainerApiRequest {
  method: PortainerApiMethod;
  path: string;
  query?: unknown;
  body?: unknown;
  body_mode?: "json" | "text";
  headers?: Record<string, string>;
  timeout_ms?: number;
}

export interface PortainerApiResponse {
  status: number;
  body: unknown;
  raw_body: string;
  raw_body_bytes: Uint8Array;
  path: string;
  method: PortainerApiMethod;
}

export interface PortainerWorkflowRequest {
  workflow: PortainerWorkflowName;
  endpoint_id?: number;
  stack_id?: number;
  container_id?: string;
  network_id?: string;
  name?: string;
  image?: string;
  volume_name?: string;
  stack_name?: string;
  stack_file_content?: string;
  unmanaged?: boolean;
  force?: boolean;
  all_unused?: boolean;
  tail?: number;
  timestamps?: boolean;
  timeout_sec?: number;
  command?: string;
  command_args?: string[];
  shell_family?: "posix" | "powershell";
  driver?: string;
  internal?: boolean;
  attachable?: boolean;
  enable_ipv6?: boolean;
  labels?: Record<string, string>;
  options?: Record<string, string>;
  names?: string[];
}

export interface PortainerWorkflowResponse {
  workflow: PortainerWorkflowName;
  result: unknown;
}

export interface PortainerDiscoveryCandidate {
  source: string;
  base_url: string | null;
  api_token_keychain: string;
  allow_insecure_tls: boolean;
}

export interface PortainerDiscoveryResult {
  default_candidate: PortainerDiscoveryCandidate | null;
  candidates: PortainerDiscoveryCandidate[];
}

type JsonRecord = Record<string, unknown>;

type RequestExecutionResult = {
  status: number;
  statusText: string;
  bodyText: string;
  bodyBytes?: Uint8Array;
};

type RequestExecutor = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  allowInsecureTls: boolean;
  timeoutMs: number;
}) => Promise<RequestExecutionResult>;

export const DEFAULT_PORTAINER_REQUEST_TIMEOUT_MS = 30_000;

function normalizeRequestTimeoutMs(value: unknown, fallback = DEFAULT_PORTAINER_REQUEST_TIMEOUT_MS): number {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.max(1_000, Math.trunc(numeric)) : fallback;
}

const defaultRequestExecutor: RequestExecutor = async ({ url, method, headers, body, allowInsecureTls, timeoutMs }) => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers,
      signal: controller.signal,
      ...(body !== undefined ? { body } : {}),
      tls: {
        rejectUnauthorized: !allowInsecureTls,
      },
    } as RequestInit & { tls: { rejectUnauthorized: boolean } });
    const bodyBytes = new Uint8Array(await response.arrayBuffer());

    return {
      status: response.status,
      statusText: response.statusText,
      bodyText: new TextDecoder().decode(bodyBytes),
      bodyBytes,
    };
  } finally {
    clearTimeout(timeoutHandle);
  }
};

let requestExecutor: RequestExecutor = defaultRequestExecutor;
const DEFAULT_PORTAINER_KEYCHAIN = process.env.PICLAW_PORTAINER_KEYCHAIN || "portainer/relay";

export function setPortainerRequestExecutorForTests(executor: RequestExecutor | null): void {
  requestExecutor = executor ?? defaultRequestExecutor;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Portainer base_url is required.");
  }
  return trimmed;
}

function normalizeApiPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Portainer request path is required.");
  }
  if (/^https?:\/\//i.test(trimmed)) {
    throw new Error("Use a relative Portainer API path, not an absolute URL.");
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function appendParam(search: URLSearchParams, key: string, value: unknown): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) appendParam(search, key, item);
    return;
  }
  if (isScalar(value)) {
    search.append(key, String(value));
    return;
  }
  search.append(key, JSON.stringify(value));
}

function toSearchParams(value: unknown): URLSearchParams {
  const search = new URLSearchParams();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return search;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    appendParam(search, key, entry);
  }
  return search;
}

function parseResponseBody(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    debugSuppressedError(log, "Failed to parse Portainer response body as JSON; returning raw text.", error, {
      operation: "portainer.parse_response_body.parse_json",
    });
    return text;
  }
}

function decodeDockerMultiplexedBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const fallbackText = new TextDecoder().decode(bytes);
  if (bytes.length < 8) return fallbackText;
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let offset = 0;
  const chunks: Buffer[] = [];
  let parsedAnyFrame = false;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const frameLength = buffer.readUInt32BE(offset + 4);
    const frameStart = offset + 8;
    const frameEnd = frameStart + frameLength;
    if (![0, 1, 2, 3].includes(streamType) || frameEnd > buffer.length) {
      return fallbackText;
    }
    chunks.push(buffer.subarray(frameStart, frameEnd));
    parsedAnyFrame = true;
    offset = frameEnd;
  }

  if (!parsedAnyFrame || offset !== buffer.length) return fallbackText;
  return Buffer.concat(chunks).toString("utf8");
}

function requirePositiveInt(value: number | undefined, field: string, workflow: PortainerWorkflowName): number {
  if (!Number.isFinite(value) || (value as number) <= 0) {
    throw new Error(`Workflow ${workflow} requires ${field}.`);
  }
  return Math.trunc(value as number);
}

function requireText(value: string | undefined, field: string, workflow: PortainerWorkflowName): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new Error(`Workflow ${workflow} requires ${field}.`);
  }
  return trimmed;
}

function normalizeContainerName(name: string): string {
  return name.replace(/^\/+/, "").trim();
}

function normalizeLookupName(name: string): string {
  return normalizeContainerName(name).toLowerCase();
}

function formatPorts(ports: Array<Record<string, unknown>> | undefined): string {
  if (!Array.isArray(ports) || ports.length === 0) return "";
  const values = new Set<string>();
  for (const port of ports) {
    const publicPort = port.PublicPort != null ? String(port.PublicPort) : "";
    const privatePort = port.PrivatePort != null ? String(port.PrivatePort) : "";
    const kind = port.Type != null ? String(port.Type) : "tcp";
    if (publicPort) values.add(`${publicPort}->${privatePort}/${kind}`);
    else values.add(`${privatePort}/${kind}`);
  }
  return [...values].join(",");
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function yamlScalar(value: unknown): string {
  if (typeof value === "string") return yamlQuote(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return '""';
  return yamlQuote(String(value));
}

function pushSection(lines: string[], title: string, values: string[]): void {
  if (values.length === 0) return;
  lines.push(`    ${title}:`);
  for (const value of values) lines.push(`      - ${value}`);
}

function asJsonRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonRecord) } : {};
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function buildUpgradeMountConfig(container: JsonRecord): JsonRecord {
  const hostConfig = asJsonRecord(container.HostConfig);
  const mounts = Array.isArray(container.Mounts) ? (container.Mounts as Array<Record<string, unknown>>) : [];
  if (mounts.length === 0) return hostConfig;

  const binds: string[] = [];
  const mountSpecs: JsonRecord[] = [];

  for (const mount of mounts) {
    const type = typeof mount.Type === "string" ? mount.Type : "";
    const destination = typeof mount.Destination === "string" ? mount.Destination : "";
    if (!type || !destination) continue;

    if (type === "bind") {
      const source = typeof mount.Source === "string" ? mount.Source : "";
      if (!source) continue;
      binds.push(`${source}:${destination}${mount.RW === false ? ":ro" : ""}`);
      continue;
    }

    const sourceName = typeof mount.Name === "string" && mount.Name.trim()
      ? mount.Name.trim()
      : (typeof mount.Source === "string" ? mount.Source : "").trim();
    if (!sourceName) continue;

    const spec: JsonRecord = {
      Type: type,
      Source: sourceName,
      Target: destination,
    };
    if (mount.RW === false) spec.ReadOnly = true;
    mountSpecs.push(spec);
  }

  if (binds.length > 0) hostConfig.Binds = binds;
  if (mountSpecs.length > 0) hostConfig.Mounts = mountSpecs;
  return hostConfig;
}

function buildUpgradeNetworkingConfig(container: JsonRecord): JsonRecord | undefined {
  const networkSettings = asJsonRecord(container.NetworkSettings);
  const networks = asJsonRecord(networkSettings.Networks);
  const endpointsConfig: Record<string, unknown> = {};

  for (const [networkName, rawValue] of Object.entries(networks)) {
    const value = asJsonRecord(rawValue);
    const endpoint: JsonRecord = {};
    const aliases = asStringArray(value.Aliases);
    const links = asStringArray(value.Links);
    if (Object.keys(asJsonRecord(value.IPAMConfig)).length > 0) endpoint.IPAMConfig = asJsonRecord(value.IPAMConfig);
    if (aliases.length > 0) endpoint.Aliases = aliases;
    if (links.length > 0) endpoint.Links = links;
    if (typeof value.MacAddress === "string" && value.MacAddress.trim()) endpoint.MacAddress = value.MacAddress.trim();
    if (Object.keys(asJsonRecord(value.DriverOpts)).length > 0) endpoint.DriverOpts = asJsonRecord(value.DriverOpts);
    if (typeof value.GwPriority === "number" && Number.isFinite(value.GwPriority)) endpoint.GwPriority = value.GwPriority;
    endpointsConfig[networkName] = endpoint;
  }

  return Object.keys(endpointsConfig).length > 0 ? { EndpointsConfig: endpointsConfig } : undefined;
}

function buildContainerCreateSpec(container: JsonRecord, targetImage: string): { name: string; body: JsonRecord } {
  const config = asJsonRecord(container.Config);
  const rawName = typeof container.Name === "string" ? normalizeContainerName(container.Name) : "";
  const name = rawName || normalizeContainerName(typeof config.Hostname === "string" ? config.Hostname : "") || "container";
  const hostConfig = buildUpgradeMountConfig(container);
  const body: JsonRecord = {
    ...config,
    Image: targetImage,
  };

  if (Object.keys(hostConfig).length > 0) body.HostConfig = hostConfig;
  const networkingConfig = buildUpgradeNetworkingConfig(container);
  if (networkingConfig) body.NetworkingConfig = networkingConfig;

  return { name, body };
}

export type StackServiceMap = {
  stackId: number;
  stackName: string;
  serviceNames: string[];
  containerNames: string[];
};

export type ContainerSummary = JsonRecord & {
  Id?: string;
  Names?: string[];
  Image?: string;
  State?: string;
  Status?: string;
  Ports?: Array<Record<string, unknown>>;
};

export type PortainerContainerRow = {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  stack: string | null;
};

function parseComposeMappings(content: string, stackId: number, stackName: string): StackServiceMap {
  const serviceNames: string[] = [];
  const containerNames: string[] = [];
  let inServices = false;
  let currentService: string | null = null;

  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!inServices) {
      if (trimmed === "services:") inServices = true;
      continue;
    }

    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^[A-Za-z0-9_.-]+:\s*$/.test(line)) break;

    const serviceMatch = line.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
    if (serviceMatch) {
      currentService = serviceMatch[1];
      serviceNames.push(currentService);
      containerNames.push(currentService);
      continue;
    }

    if (!currentService) continue;

    const containerMatch = line.match(/^\s{4}container_name:\s*(.+?)\s*$/);
    if (containerMatch) {
      const containerName = normalizeContainerName(containerMatch[1]);
      if (containerName && !containerNames.includes(containerName)) containerNames.push(containerName);
    }
  }

  return { stackId, stackName, serviceNames, containerNames };
}

function buildContainerComposeService(container: JsonRecord): string {
  const lines: string[] = ["services:"];
  const rawName = typeof container.Name === "string" ? normalizeContainerName(container.Name) : "container";
  const serviceName = rawName.replace(/[^A-Za-z0-9_.-]+/g, "-") || "container";
  const image = typeof (container.Config as any)?.Image === "string" ? (container.Config as any).Image : "";
  const hostname = typeof (container.Config as any)?.Hostname === "string" ? (container.Config as any).Hostname : "";
  const restart = typeof (container.HostConfig as any)?.RestartPolicy?.Name === "string" ? (container.HostConfig as any).RestartPolicy.Name : "";
  const env = Array.isArray((container.Config as any)?.Env) ? ((container.Config as any).Env as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  const binds = Array.isArray((container.HostConfig as any)?.Binds) ? ((container.HostConfig as any).Binds as unknown[]).filter((entry): entry is string => typeof entry === "string") : [];
  const portBindings = (container.HostConfig as any)?.PortBindings as Record<string, Array<Record<string, unknown>>> | undefined;

  lines.push(`  ${serviceName}:`);
  if (rawName) lines.push(`    container_name: ${rawName}`);
  if (hostname && hostname !== rawName && !/^[0-9a-f]{12,}$/i.test(hostname)) lines.push(`    hostname: ${hostname}`);
  if (image) lines.push(`    image: ${image}`);
  if (restart && restart !== "no") lines.push(`    restart: ${restart}`);

  const portLines: string[] = [];
  if (portBindings && typeof portBindings === "object") {
    for (const [privatePort, bindings] of Object.entries(portBindings)) {
      const [containerPort, protocol = "tcp"] = privatePort.split("/");
      if (!Array.isArray(bindings) || bindings.length === 0) {
        portLines.push(yamlQuote(protocol === "tcp" ? containerPort : `${containerPort}/${protocol}`));
        continue;
      }
      for (const binding of bindings) {
        const hostPort = typeof binding?.HostPort === "string" ? binding.HostPort : "";
        const hostIp = typeof binding?.HostIp === "string" ? binding.HostIp : "";
        const suffix = protocol === "tcp" ? containerPort : `${containerPort}/${protocol}`;
        if (hostPort && hostIp && hostIp !== "0.0.0.0" && hostIp !== "::") {
          portLines.push(yamlQuote(`${hostIp}:${hostPort}:${suffix}`));
        } else if (hostPort) {
          portLines.push(yamlQuote(`${hostPort}:${suffix}`));
        } else {
          portLines.push(yamlQuote(suffix));
        }
      }
    }
  }

  pushSection(lines, "ports", portLines);
  pushSection(lines, "volumes", binds.map((entry) => yamlQuote(entry)));
  pushSection(lines, "environment", env.map((entry) => yamlScalar(entry)));

  return `${lines.join("\n")}\n`;
}

export async function resolvePortainerAuth(apiTokenKeychain: string): Promise<PortainerApiAuth> {
  const entry = await getKeychainEntry(apiTokenKeychain);
  const token = entry.secret.trim();
  if (!token) {
    throw new Error(`Keychain entry ${apiTokenKeychain} must provide a Portainer API token in the secret field.`);
  }
  const baseUrl = entry.username?.trim() || null;
  return { base_url: baseUrl, token };
}

export async function discoverPortainerInstances(defaultConfig?: Partial<Pick<PortainerApiConfig, "base_url" | "api_token_keychain" | "allow_insecure_tls">>): Promise<PortainerDiscoveryResult> {
  const envBase = (process.env.PICLAW_PORTAINER_BASE || process.env.PORTAINER_BASE || "").trim() || null;
  const defaultBaseUrl = defaultConfig?.base_url?.trim() || envBase || null;
  const defaultKeychain = defaultConfig?.api_token_keychain?.trim() || DEFAULT_PORTAINER_KEYCHAIN;
  const defaultAllowInsecureTls = defaultConfig?.allow_insecure_tls ?? true;
  const keychains = listKeychainEntries()
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("portainer/"));

  const candidates: PortainerDiscoveryCandidate[] = [];
  if (defaultBaseUrl && defaultKeychain) {
    candidates.push({
      source: "settings",
      base_url: defaultBaseUrl,
      api_token_keychain: defaultKeychain,
      allow_insecure_tls: defaultAllowInsecureTls,
    });
  }

  for (const name of keychains) {
    try {
      const auth = await resolvePortainerAuth(name);
      candidates.push({
        source: name === DEFAULT_PORTAINER_KEYCHAIN ? "default-keychain" : "keychain",
        base_url: defaultBaseUrl || auth.base_url,
        api_token_keychain: name,
        allow_insecure_tls: defaultAllowInsecureTls,
      });
    } catch (error) {
      debugSuppressedError(log, "Skipping unusable Portainer discovery keychain entry.", error, {
        operation: "portainer.discover_instances.resolve_auth",
        apiTokenKeychain: name,
      });
    }
  }

  const uniqueCandidates = candidates.filter((candidate, index, array) =>
    array.findIndex((entry) => entry.api_token_keychain === candidate.api_token_keychain && entry.base_url === candidate.base_url) === index
  );

  const defaultCandidate = uniqueCandidates.find((candidate) => candidate.api_token_keychain === defaultKeychain && candidate.base_url === defaultBaseUrl)
    ?? uniqueCandidates.find((candidate) => candidate.api_token_keychain === DEFAULT_PORTAINER_KEYCHAIN)
    ?? uniqueCandidates[0]
    ?? (defaultBaseUrl && defaultKeychain
      ? {
          source: defaultConfig?.base_url ? "settings" : "env",
          base_url: defaultBaseUrl,
          api_token_keychain: defaultKeychain,
          allow_insecure_tls: defaultAllowInsecureTls,
        }
      : null);

  return {
    default_candidate: defaultCandidate,
    candidates: uniqueCandidates,
  };
}

export async function requestPortainerApi(
  config: PortainerApiConfig,
  request: PortainerApiRequest,
): Promise<PortainerApiResponse> {
  const auth = await resolvePortainerAuth(config.api_token_keychain);
  const baseUrl = normalizeBaseUrl(config.base_url || auth.base_url || "");
  const path = normalizeApiPath(request.path);
  const query = toSearchParams(request.query);
  const url = `${baseUrl}${path}${query.size ? `?${query.toString()}` : ""}`;
  const timeoutMs = normalizeRequestTimeoutMs(request.timeout_ms);

  const headers: Record<string, string> = {
    "X-API-Key": auth.token,
    Accept: "application/json",
    ...(request.headers || {}),
  };

  let bodyText: string | undefined;
  if (request.body !== undefined) {
    if (request.body_mode === "text") {
      headers["Content-Type"] = headers["Content-Type"] || "text/plain; charset=utf-8";
      bodyText = typeof request.body === "string" ? request.body : String(request.body);
    } else {
      headers["Content-Type"] = headers["Content-Type"] || "application/json";
      bodyText = JSON.stringify(request.body);
    }
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let result: RequestExecutionResult;
  try {
    result = await Promise.race([
      requestExecutor({
        url,
        method: request.method,
        headers,
        ...(bodyText !== undefined ? { body: bodyText } : {}),
        allowInsecureTls: config.allow_insecure_tls,
        timeoutMs,
      }),
      new Promise<RequestExecutionResult>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`Portainer API ${request.method} ${path} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("timed out after")) throw new Error(message);
    if (/abort|aborted/i.test(message)) {
      throw new Error(`Portainer API ${request.method} ${path} timed out after ${timeoutMs}ms.`);
    }
    throw new Error(`Portainer API ${request.method} ${path} failed before response: ${message}`);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
  const rawBodyBytes = result.bodyBytes ?? new TextEncoder().encode(result.bodyText);

  const body = parseResponseBody(result.bodyText);
  if (result.status >= 400) {
    const errorBody = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Portainer API ${request.method} ${path} failed with HTTP ${result.status}: ${errorBody}`);
  }

  return {
    status: result.status,
    body,
    raw_body: result.bodyText,
    raw_body_bytes: rawBodyBytes,
    path,
    method: request.method,
  };
}

export class PortainerClient {
  constructor(private readonly config: PortainerApiConfig) {}

  async request(request: PortainerApiRequest): Promise<PortainerApiResponse> {
    return requestPortainerApi(this.config, request);
  }

  async listEndpoints(): Promise<JsonRecord[]> {
    const response = await this.request({ method: "GET", path: "/api/endpoints" });
    return Array.isArray(response.body) ? (response.body as JsonRecord[]) : [];
  }

  async getEndpoint(endpointId: number): Promise<JsonRecord> {
    const endpoints = await this.listEndpoints();
    const endpoint = endpoints.find((entry) => Number(entry.Id) === endpointId);
    if (!endpoint) {
      throw new Error(`Endpoint ${endpointId} not found.`);
    }
    return endpoint;
  }

  async resolveEndpoint(input: { endpoint_id?: number; name?: string }): Promise<JsonRecord> {
    const endpoints = await this.listEndpoints();
    if (typeof input.endpoint_id === "number" && input.endpoint_id > 0) {
      const byId = endpoints.find((entry) => Number(entry.Id) === Math.trunc(input.endpoint_id as number));
      if (byId) return byId;
    }
    const name = typeof input.name === "string" ? normalizeLookupName(input.name) : "";
    if (name) {
      const byName = endpoints.find((entry) => normalizeLookupName(String(entry.Name ?? "")) === name || normalizeLookupName(String(entry.URL ?? "")) === name);
      if (byName) return byName;
    }
    throw new Error(`Endpoint not found.`);
  }

  async pingEndpoint(endpointId: number): Promise<{ endpoint_id: number; ok: boolean; response: string }> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/_ping`,
      headers: { Accept: "text/plain" },
    });
    const text = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return {
      endpoint_id: endpointId,
      ok: String(text || "").trim().toUpperCase() === "OK",
      response: String(text || "").trim(),
    };
  }

  async getDockerInfo(endpointId: number): Promise<JsonRecord> {
    const response = await this.request({ method: "GET", path: `/api/endpoints/${endpointId}/docker/info` });
    return (response.body ?? {}) as JsonRecord;
  }

  async getDockerVersion(endpointId: number): Promise<JsonRecord> {
    const response = await this.request({ method: "GET", path: `/api/endpoints/${endpointId}/docker/version` });
    return (response.body ?? {}) as JsonRecord;
  }

  async getDockerSystemDf(endpointId: number): Promise<JsonRecord> {
    const response = await this.request({ method: "GET", path: `/api/endpoints/${endpointId}/docker/system/df` });
    return (response.body ?? {}) as JsonRecord;
  }

  async listStacks(endpointId?: number): Promise<JsonRecord[]> {
    const response = await this.request({ method: "GET", path: "/api/stacks" });
    const stacks = Array.isArray(response.body) ? (response.body as JsonRecord[]) : [];
    if (!endpointId) return stacks;
    return stacks.filter((entry) => Number(entry.EndpointId) === endpointId);
  }

  async resolveStack(input: { endpoint_id?: number; stack_id?: number; stack_name?: string; name?: string }): Promise<JsonRecord> {
    const stacks = await this.listStacks(input.endpoint_id);
    if (typeof input.stack_id === "number" && input.stack_id > 0) {
      const byId = stacks.find((entry) => Number(entry.Id) === Math.trunc(input.stack_id as number));
      if (byId) return byId;
    }
    const stackName = typeof input.stack_name === "string" && input.stack_name.trim()
      ? normalizeLookupName(input.stack_name)
      : normalizeLookupName(typeof input.name === "string" ? input.name : "");
    if (stackName) {
      const byName = stacks.find((entry) => normalizeLookupName(String(entry.Name ?? "")) === stackName);
      if (byName) return byName;
    }
    throw new Error(`Stack not found.`);
  }

  async getStackFile(stackId: number): Promise<string> {
    const response = await this.request({ method: "GET", path: `/api/stacks/${stackId}/file` });
    const content = typeof (response.body as any)?.StackFileContent === "string" ? (response.body as any).StackFileContent : "";
    if (!content) throw new Error(`Stack ${stackId} returned no stack file content.`);
    return content;
  }

  async createStandaloneStack(endpointId: number, name: string, stackFileContent: string): Promise<JsonRecord> {
    const response = await this.request({
      method: "POST",
      path: "/api/stacks/create/standalone/string",
      query: { endpointId },
      body: { Name: name, StackFileContent: stackFileContent, Env: [] },
      body_mode: "json",
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async updateStack(endpointId: number, stackId: number, stackFileContent: string, options: { pull_image?: boolean } = {}): Promise<JsonRecord> {
    const response = await this.request({
      method: "PUT",
      path: `/api/stacks/${stackId}`,
      query: { endpointId },
      body: { stackFileContent, env: [], ...(options.pull_image ? { pullImage: true } : {}) },
      body_mode: "json",
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async deleteStack(endpointId: number, stackId: number): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/api/stacks/${stackId}`,
      query: { endpointId },
    });
  }

  async listContainers(endpointId: number): Promise<ContainerSummary[]> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/containers/json`,
      query: { all: 1 },
    });
    return Array.isArray(response.body) ? (response.body as ContainerSummary[]) : [];
  }

  async inspectContainer(endpointId: number, containerId: string): Promise<JsonRecord> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/json`,
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async startContainer(endpointId: number, containerId: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/start`,
    });
  }

  async stopContainer(endpointId: number, containerId: string, timeoutSec?: number): Promise<void> {
    await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/stop`,
      ...(typeof timeoutSec === "number" && timeoutSec > 0 ? { query: { t: Math.trunc(timeoutSec) } } : {}),
    });
  }

  async restartContainer(endpointId: number, containerId: string, timeoutSec?: number): Promise<void> {
    await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/restart`,
      ...(typeof timeoutSec === "number" && timeoutSec > 0 ? { query: { t: Math.trunc(timeoutSec) } } : {}),
    });
  }

  async renameContainer(endpointId: number, containerId: string, name: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/rename`,
      query: { name },
    });
  }

  async createContainer(endpointId: number, name: string, body: JsonRecord): Promise<JsonRecord> {
    const response = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/create`,
      query: { name },
      body,
      body_mode: "json",
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async getContainerLogs(endpointId: number, containerId: string, options: { tail?: number; timestamps?: boolean } = {}): Promise<string> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/logs`,
      query: {
        stdout: true,
        stderr: true,
        tail: typeof options.tail === "number" && options.tail > 0 ? Math.trunc(options.tail) : 200,
        timestamps: options.timestamps === true,
      },
      headers: { Accept: "text/plain" },
    });
    return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  }

  async getContainerMounts(endpointId: number, containerId: string): Promise<Array<Record<string, unknown>>> {
    const payload = await this.inspectContainer(endpointId, containerId);
    return Array.isArray(payload.Mounts) ? (payload.Mounts as Array<Record<string, unknown>>) : [];
  }

  async deleteContainer(endpointId: number, containerId: string, force: boolean): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}`,
      query: force ? { force: true, v: true } : undefined,
    });
  }

  async listImages(endpointId: number): Promise<JsonRecord[]> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/images/json`,
      query: { all: 1 },
    });
    return Array.isArray(response.body) ? (response.body as JsonRecord[]) : [];
  }

  async inspectImage(endpointId: number, image: string): Promise<JsonRecord> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/images/${encodeURIComponent(image)}/json`,
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async pullImage(endpointId: number, image: string): Promise<string> {
    const [fromImage, tag = "latest"] = image.includes(":") ? [image.slice(0, image.lastIndexOf(":")), image.slice(image.lastIndexOf(":") + 1)] : [image, "latest"];
    const response = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/images/create`,
      query: { fromImage, tag },
      headers: { Accept: "text/plain" },
    });
    return typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  }

  async deleteImage(endpointId: number, image: string, force: boolean): Promise<unknown> {
    const response = await this.request({
      method: "DELETE",
      path: `/api/endpoints/${endpointId}/docker/images/${encodeURIComponent(image)}`,
      ...(force ? { query: { force: true } } : {}),
    });
    return response.body;
  }

  async checkImageUpdate(endpointId: number, image: string): Promise<JsonRecord> {
    const local = await this.inspectImage(endpointId, image);
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/distribution/${encodeURIComponent(image)}/json`,
    });
    const remote = (response.body ?? {}) as JsonRecord;
    const localDigests = Array.isArray(local.RepoDigests)
      ? (local.RepoDigests as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [];
    const remoteDigest = typeof (remote.Descriptor as JsonRecord | undefined)?.digest === "string"
      ? String((remote.Descriptor as JsonRecord).digest)
      : null;
    const upToDate = !!remoteDigest && localDigests.some((entry) => entry.endsWith(`@${remoteDigest}`) || entry.endsWith(remoteDigest));
    return {
      image,
      local_id: typeof local.Id === "string" ? local.Id : null,
      local_repo_digests: localDigests,
      remote_digest: remoteDigest,
      up_to_date: upToDate,
      remote,
    };
  }

  async pruneImages(endpointId: number, allUnused: boolean): Promise<unknown> {
    const response = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/images/prune`,
      ...(allUnused ? { query: { filters: { dangling: ["false"] } } } : {}),
    });
    return response.body;
  }

  async listVolumes(endpointId: number): Promise<JsonRecord[]> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/volumes`,
    });
    return Array.isArray((response.body as { Volumes?: unknown })?.Volumes)
      ? (((response.body as { Volumes?: unknown }).Volumes) as JsonRecord[])
      : [];
  }

  async inspectVolume(endpointId: number, volumeName: string): Promise<JsonRecord> {
    const response = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/volumes/${encodeURIComponent(volumeName)}`,
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async createVolume(endpointId: number, body: JsonRecord): Promise<JsonRecord> {
    const response = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/volumes/create`,
      body,
      body_mode: "json",
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async deleteVolume(endpointId: number, volumeName: string, force: boolean): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/api/endpoints/${endpointId}/docker/volumes/${encodeURIComponent(volumeName)}`,
      ...(force ? { query: { force: true } } : {}),
    });
  }

  async pruneVolumes(endpointId: number): Promise<unknown> {
    const response = await this.request({ method: "POST", path: `/api/endpoints/${endpointId}/docker/volumes/prune` });
    return response.body;
  }

  async listNetworks(endpointId: number): Promise<JsonRecord[]> {
    const response = await this.request({ method: "GET", path: `/api/endpoints/${endpointId}/docker/networks` });
    return Array.isArray(response.body) ? (response.body as JsonRecord[]) : [];
  }

  async resolveNetwork(endpointId: number, input: { network_id?: string; name?: string }): Promise<JsonRecord> {
    const networkId = typeof input.network_id === "string" ? input.network_id.trim() : "";
    const name = typeof input.name === "string" ? normalizeLookupName(input.name) : "";
    const networks = await this.listNetworks(endpointId);
    if (networkId) {
      const byId = networks.find((entry) => String(entry.Id ?? "").startsWith(networkId));
      if (byId) return byId;
    }
    if (name) {
      const byName = networks.find((entry) => normalizeLookupName(String(entry.Name ?? "")) === name);
      if (byName) return byName;
    }
    throw new Error(`Network not found on endpoint ${endpointId}.`);
  }

  async inspectNetwork(endpointId: number, networkId: string): Promise<JsonRecord> {
    const response = await this.request({ method: "GET", path: `/api/endpoints/${endpointId}/docker/networks/${encodeURIComponent(networkId)}` });
    return (response.body ?? {}) as JsonRecord;
  }

  async createNetwork(endpointId: number, body: JsonRecord): Promise<JsonRecord> {
    const response = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/networks/create`,
      body,
      body_mode: "json",
    });
    return (response.body ?? {}) as JsonRecord;
  }

  async deleteNetwork(endpointId: number, networkId: string): Promise<void> {
    await this.request({ method: "DELETE", path: `/api/endpoints/${endpointId}/docker/networks/${encodeURIComponent(networkId)}` });
  }

  async execContainer(endpointId: number, containerId: string, input: { command: string; command_args?: string[]; shell_family?: "posix" | "powershell" }): Promise<Record<string, unknown>> {
    const wrappedCommand = await buildInjectedExecCommand(input.shell_family ?? "posix", input.command, input.command_args || []);
    const createResponse = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/containers/${encodeURIComponent(containerId)}/exec`,
      body: {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: [wrappedCommand.command, ...wrappedCommand.commandArgs],
        ...(Object.keys(wrappedCommand.env).length > 0
          ? { Env: Object.entries(wrappedCommand.env).map(([key, value]) => `${key}=${value}`) }
          : {}),
      },
      body_mode: "json",
    });
    const execId = typeof (createResponse.body as JsonRecord | null)?.Id === "string"
      ? String((createResponse.body as JsonRecord).Id)
      : "";
    if (!execId) throw new Error(`Portainer did not return an exec ID for container ${containerId}.`);

    const startResponse = await this.request({
      method: "POST",
      path: `/api/endpoints/${endpointId}/docker/exec/${encodeURIComponent(execId)}/start`,
      body: { Detach: false, Tty: false },
      body_mode: "json",
      headers: { Accept: "text/plain" },
    });

    const inspectResponse = await this.request({
      method: "GET",
      path: `/api/endpoints/${endpointId}/docker/exec/${encodeURIComponent(execId)}/json`,
    });

    const decodedOutput = decodeDockerMultiplexedBytes(startResponse.raw_body_bytes);
    return {
      exec_id: execId,
      output: decodedOutput,
      inspect: inspectResponse.body,
    };
  }

  async getStackServiceMaps(endpointId: number): Promise<StackServiceMap[]> {
    const stacks = await this.listStacks(endpointId);
    const mappings: StackServiceMap[] = [];
    for (const stack of stacks) {
      const stackId = Number(stack.Id);
      if (!Number.isFinite(stackId) || stackId <= 0) continue;
      const stackName = typeof stack.Name === "string" ? stack.Name : String(stackId);
      try {
        const content = await this.getStackFile(stackId);
        mappings.push(parseComposeMappings(content, stackId, stackName));
      } catch (error) {
        debugSuppressedError(log, "Skipping unreadable Portainer stack file during ownership mapping.", error, {
          operation: "portainer.get_stack_service_maps.read_stack_file",
          endpointId,
          stackId,
          stackName,
        });
      }
    }
    return mappings;
  }

  async resolveContainer(endpointId: number, input: { container_id?: string; name?: string }): Promise<ContainerSummary> {
    const id = input.container_id?.trim();
    const name = input.name?.trim();
    if (!id && !name) {
      throw new Error(`Portainer container workflows require container_id or name.`);
    }

    const containers = await this.listContainers(endpointId);
    if (id) {
      const exact = containers.find((entry) => typeof entry.Id === "string" && entry.Id === id);
      if (exact) return exact;

      if (id.length < 12) {
        throw new Error("Container id prefixes must be at least 12 characters.");
      }

      const byId = containers.filter((entry) => typeof entry.Id === "string" && entry.Id.startsWith(id));
      if (byId.length === 1) return byId[0];
      if (byId.length > 1) {
        throw new Error(`Container id prefix "${id}" is ambiguous on endpoint ${endpointId}.`);
      }
    }

    if (name) {
      const normalized = normalizeContainerName(name);
      const byName = containers.find((entry) => Array.isArray(entry.Names) && entry.Names.some((value) => normalizeContainerName(value) === normalized));
      if (byName) return byName;
    }

    throw new Error(`Container not found on endpoint ${endpointId}.`);
  }

  async listContainerRows(endpointId: number, unmanagedOnly: boolean): Promise<PortainerContainerRow[]> {
    const containers = await this.listContainers(endpointId);
    const mappings = await this.getStackServiceMaps(endpointId);
    const ownership = new Map<string, string>();
    for (const mapping of mappings) {
      for (const name of mapping.containerNames) ownership.set(normalizeContainerName(name), mapping.stackName);
    }

    const rows = containers.map((container) => {
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : String(container.Id ?? ""));
      return {
        id: String(container.Id ?? ""),
        name,
        image: String(container.Image ?? ""),
        state: String(container.State ?? ""),
        status: String(container.Status ?? ""),
        ports: formatPorts(container.Ports),
        stack: ownership.get(name) || null,
      };
    });

    return unmanagedOnly ? rows.filter((entry) => !entry.stack) : rows;
  }

  async buildContainerCompose(endpointId: number, input: { container_id?: string; name?: string }): Promise<{ id: string; compose: string }> {
    const container = await this.resolveContainer(endpointId, input);
    const id = typeof container.Id === "string" ? container.Id : "";
    if (!id) {
      throw new Error(`Container on endpoint ${endpointId} has no ID.`);
    }
    const payload = await this.inspectContainer(endpointId, id);
    return { id, compose: buildContainerComposeService(payload) };
  }

  async resolveContainerStack(endpointId: number, input: { container_id?: string; name?: string }): Promise<string | null> {
    const container = await this.resolveContainer(endpointId, input);
    const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : String(container.Id ?? ""));
    if (!name) return null;

    const mappings = await this.getStackServiceMaps(endpointId);
    for (const mapping of mappings) {
      if (mapping.containerNames.includes(name)) return mapping.stackName;
    }
    return null;
  }

  async upgradeContainer(
    endpointId: number,
    input: { container_id?: string; name?: string; image?: string; timeout_sec?: number; force?: boolean },
  ): Promise<JsonRecord> {
    const container = await this.resolveContainer(endpointId, input);
    const oldId = typeof container.Id === "string" ? container.Id : "";
    if (!oldId) throw new Error(`Container on endpoint ${endpointId} has no ID.`);

    const inspected = await this.inspectContainer(endpointId, oldId);
    const currentName = normalizeContainerName(typeof inspected.Name === "string" ? inspected.Name : Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : oldId);
    const stackName = await this.resolveContainerStack(endpointId, { container_id: oldId, name: currentName });
    if (stackName) {
      throw new Error(`Container ${currentName} belongs to stack ${stackName}; use stack.update instead.`);
    }

    const currentImage = typeof (inspected.Config as JsonRecord | undefined)?.Image === "string"
      ? String((inspected.Config as JsonRecord).Image)
      : String(container.Image ?? "");
    const targetImage = requireText(input.image ?? currentImage, "image", "container.upgrade");
    const pullOutput = await this.pullImage(endpointId, targetImage);

    const backupName = `${currentName}-backup-${Date.now().toString(36)}`;
    let stoppedOld = false;
    let renamedOld = false;

    try {
      await this.stopContainer(endpointId, oldId, input.timeout_sec);
      stoppedOld = true;
      await this.renameContainer(endpointId, oldId, backupName);
      renamedOld = true;

      const createSpec = buildContainerCreateSpec(inspected, targetImage);
      const created = await this.createContainer(endpointId, currentName, createSpec.body);
      const newId = typeof created.Id === "string" ? created.Id : "";
      if (!newId) throw new Error(`Portainer did not return a new container ID for ${currentName}.`);

      try {
        await this.startContainer(endpointId, newId);
      } catch (error) {
        try {
          await this.deleteContainer(endpointId, newId, true);
        } catch (cleanupError) {
          debugSuppressedError(log, "Failed to remove the newly created Portainer container during upgrade rollback.", cleanupError, {
            operation: "portainer.upgrade_container.cleanup_new_container",
            endpointId,
            currentName,
            newId,
          });
        }
        throw error;
      }

      let previousContainerDeleted = true;
      let previousContainerDeleteError: string | null = null;
      try {
        await this.deleteContainer(endpointId, oldId, input.force === true);
      } catch (error) {
        previousContainerDeleted = false;
        previousContainerDeleteError = error instanceof Error ? error.message : String(error);
      }

      return {
        ok: true,
        endpoint_id: endpointId,
        name: currentName,
        old_id: oldId,
        new_id: newId,
        current_image: currentImage,
        target_image: targetImage,
        pull_output: pullOutput,
        backup_name: backupName,
        previous_container_deleted: previousContainerDeleted,
        ...(previousContainerDeleteError ? { previous_container_delete_error: previousContainerDeleteError } : {}),
      };
    } catch (error) {
      if (renamedOld) {
        try {
          await this.renameContainer(endpointId, oldId, currentName);
        } catch (rollbackError) {
          debugSuppressedError(log, "Failed to restore the original Portainer container name during upgrade rollback.", rollbackError, {
            operation: "portainer.upgrade_container.restore_name",
            endpointId,
            currentName,
            oldId,
          });
        }
      }
      if (stoppedOld) {
        try {
          await this.startContainer(endpointId, oldId);
        } catch (rollbackError) {
          debugSuppressedError(log, "Failed to restart the original Portainer container during upgrade rollback.", rollbackError, {
            operation: "portainer.upgrade_container.restart_original",
            endpointId,
            currentName,
            oldId,
          });
        }
      }
      throw new Error(
        `Failed to upgrade container ${currentName} on endpoint ${endpointId}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async upgradeManyContainers(
    endpointId: number,
    input: { names: string[]; image?: string; timeout_sec?: number; force?: boolean },
  ): Promise<JsonRecord> {
    const results: JsonRecord[] = [];
    let upgraded = 0;
    let failed = 0;

    for (const rawName of input.names) {
      const name = normalizeContainerName(rawName);
      if (!name) continue;
      try {
        const result = await this.upgradeContainer(endpointId, {
          name,
          ...(typeof input.image === "string" ? { image: input.image } : {}),
          ...(typeof input.timeout_sec === "number" ? { timeout_sec: input.timeout_sec } : {}),
          ...(typeof input.force === "boolean" ? { force: input.force } : {}),
        });
        upgraded += 1;
        results.push({ name, ok: true, ...result });
      } catch (error) {
        failed += 1;
        results.push({ name, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      endpoint_id: endpointId,
      total: results.length,
      upgraded,
      failed,
      ok: failed === 0,
      results,
    };
  }
}

export async function runPortainerWorkflow(
  config: PortainerApiConfig,
  input: PortainerWorkflowRequest,
): Promise<PortainerWorkflowResponse> {
  const client = new PortainerClient(config);
  const workflow = input.workflow;

  switch (workflow) {
    case "endpoint.list": {
      return { workflow, result: await client.listEndpoints() };
    }
    case "endpoint.resolve": {
      return { workflow, result: await client.resolveEndpoint({ endpoint_id: input.endpoint_id, name: input.name }) };
    }
    case "endpoint.inspect": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.getEndpoint(endpointId) };
    }
    case "endpoint.ping": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.pingEndpoint(endpointId) };
    }
    case "endpoint.docker_info": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.getDockerInfo(endpointId) };
    }
    case "endpoint.docker_version": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.getDockerVersion(endpointId) };
    }
    case "endpoint.system_df": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.getDockerSystemDf(endpointId) };
    }
    case "stack.list": {
      return { workflow, result: await client.listStacks(input.endpoint_id) };
    }
    case "stack.resolve": {
      return { workflow, result: await client.resolveStack({ endpoint_id: input.endpoint_id, stack_id: input.stack_id, stack_name: input.stack_name, name: input.name }) };
    }
    case "stack.file": {
      const stack = await client.resolveStack({ endpoint_id: input.endpoint_id, stack_id: input.stack_id, stack_name: input.stack_name, name: input.name });
      const stackId = Number(stack.Id);
      return { workflow, result: { stack_id: stackId, content: await client.getStackFile(stackId) } };
    }
    case "stack.create_standalone": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const name = requireText(input.stack_name, "stack_name", workflow);
      const stackFileContent = requireText(input.stack_file_content, "stack_file_content", workflow);
      return {
        workflow,
        result: await client.createStandaloneStack(endpointId, name, stackFileContent),
      };
    }
    case "stack.update": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const stackId = requirePositiveInt(input.stack_id, "stack_id", workflow);
      const stackFileContent = requireText(input.stack_file_content, "stack_file_content", workflow);
      return {
        workflow,
        result: await client.updateStack(endpointId, stackId, stackFileContent),
      };
    }
    case "stack.pull_and_update": {
      const stack = await client.resolveStack({ endpoint_id: input.endpoint_id, stack_id: input.stack_id, stack_name: input.stack_name, name: input.name });
      const endpointId = Number(stack.EndpointId);
      const stackId = Number(stack.Id);
      if (!Number.isFinite(endpointId) || endpointId <= 0 || !Number.isFinite(stackId) || stackId <= 0) {
        throw new Error(`Workflow ${workflow} requires a resolvable stack endpoint/id.`);
      }
      const stackFileContent = await client.getStackFile(stackId);
      return {
        workflow,
        result: await client.updateStack(endpointId, stackId, stackFileContent, { pull_image: true }),
      };
    }
    case "stack.delete": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const stackId = requirePositiveInt(input.stack_id, "stack_id", workflow);
      await client.deleteStack(endpointId, stackId);
      return { workflow, result: { ok: true, endpoint_id: endpointId, stack_id: stackId } };
    }
    case "container.list": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.listContainerRows(endpointId, input.unmanaged === true) };
    }
    case "container.resolve": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : id);
      const stack = await client.resolveContainerStack(endpointId, { container_id: id, name });
      return {
        workflow,
        result: {
          id,
          name,
          image: String(container.Image ?? ""),
          state: String(container.State ?? ""),
          status: String(container.Status ?? ""),
          stack,
        },
      };
    }
    case "container.inspect": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      return { workflow, result: await client.inspectContainer(endpointId, id) };
    }
    case "container.compose": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.buildContainerCompose(endpointId, input) };
    }
    case "container.start": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      await client.startContainer(endpointId, id);
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : id);
      return { workflow, result: { ok: true, endpoint_id: endpointId, id, name } };
    }
    case "container.stop": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      await client.stopContainer(endpointId, id, input.timeout_sec);
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : id);
      return { workflow, result: { ok: true, endpoint_id: endpointId, id, name } };
    }
    case "container.restart": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      await client.restartContainer(endpointId, id, input.timeout_sec);
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : id);
      return { workflow, result: { ok: true, endpoint_id: endpointId, id, name } };
    }
    case "container.logs": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      return { workflow, result: { id, logs: await client.getContainerLogs(endpointId, id, { tail: input.tail, timestamps: input.timestamps }) } };
    }
    case "container.mounts": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      return { workflow, result: { id, mounts: await client.getContainerMounts(endpointId, id) } };
    }
    case "container.exec": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const command = requireText(input.command, "command", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      return {
        workflow,
        result: await client.execContainer(endpointId, id, {
          command,
          ...(Array.isArray(input.command_args) ? { command_args: input.command_args } : {}),
          ...(input.shell_family === "powershell" || input.shell_family === "posix" ? { shell_family: input.shell_family } : {}),
        }),
      };
    }
    case "container.upgrade": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return {
        workflow,
        result: await client.upgradeContainer(endpointId, {
          ...(typeof input.container_id === "string" ? { container_id: input.container_id } : {}),
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(typeof input.image === "string" ? { image: input.image } : {}),
          ...(typeof input.timeout_sec === "number" ? { timeout_sec: input.timeout_sec } : {}),
          ...(typeof input.force === "boolean" ? { force: input.force } : {}),
        }),
      };
    }
    case "container.upgrade_many": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const names = Array.isArray(input.names)
        ? input.names.map((entry) => normalizeContainerName(entry)).filter(Boolean)
        : [];
      if (names.length === 0) {
        throw new Error(`Workflow ${workflow} requires names.`);
      }
      return {
        workflow,
        result: await client.upgradeManyContainers(endpointId, {
          names,
          ...(typeof input.image === "string" ? { image: input.image } : {}),
          ...(typeof input.timeout_sec === "number" ? { timeout_sec: input.timeout_sec } : {}),
          ...(typeof input.force === "boolean" ? { force: input.force } : {}),
        }),
      };
    }
    case "container.delete": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const container = await client.resolveContainer(endpointId, input);
      const id = typeof container.Id === "string" ? container.Id : "";
      if (!id) throw new Error(`Container on endpoint ${endpointId} has no ID.`);
      await client.deleteContainer(endpointId, id, input.force === true);
      const name = normalizeContainerName(Array.isArray(container.Names) && container.Names[0] ? container.Names[0] : id);
      return { workflow, result: { ok: true, endpoint_id: endpointId, id, name } };
    }
    case "image.list": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.listImages(endpointId) };
    }
    case "image.inspect": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const image = requireText(input.image ?? input.name, "image", workflow);
      return { workflow, result: await client.inspectImage(endpointId, image) };
    }
    case "image.pull": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const image = requireText(input.image ?? input.name, "image", workflow);
      return { workflow, result: { image, output: await client.pullImage(endpointId, image) } };
    }
    case "image.delete": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const image = requireText(input.image ?? input.name, "image", workflow);
      return { workflow, result: await client.deleteImage(endpointId, image, input.force === true) };
    }
    case "image.prune": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.pruneImages(endpointId, input.all_unused === true) };
    }
    case "image.update_check": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const image = requireText(input.image ?? input.name, "image", workflow);
      return { workflow, result: await client.checkImageUpdate(endpointId, image) };
    }
    case "network.list": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.listNetworks(endpointId) };
    }
    case "network.inspect": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const network = await client.resolveNetwork(endpointId, { network_id: input.network_id, name: input.name });
      const networkId = typeof network.Id === "string" ? network.Id : String(network.Id ?? "");
      return { workflow, result: await client.inspectNetwork(endpointId, networkId) };
    }
    case "network.create": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const name = requireText(input.name, "name", workflow);
      return {
        workflow,
        result: await client.createNetwork(endpointId, {
          Name: name,
          ...(typeof input.driver === "string" && input.driver.trim() ? { Driver: input.driver.trim() } : {}),
          ...(typeof input.internal === "boolean" ? { Internal: input.internal } : {}),
          ...(typeof input.attachable === "boolean" ? { Attachable: input.attachable } : {}),
          ...(typeof input.enable_ipv6 === "boolean" ? { EnableIPv6: input.enable_ipv6 } : {}),
          ...(input.labels ? { Labels: input.labels } : {}),
          ...(input.options ? { Options: input.options } : {}),
        }),
      };
    }
    case "network.delete": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const network = await client.resolveNetwork(endpointId, { network_id: input.network_id, name: input.name });
      const networkId = typeof network.Id === "string" ? network.Id : String(network.Id ?? "");
      await client.deleteNetwork(endpointId, networkId);
      return { workflow, result: { ok: true, endpoint_id: endpointId, id: networkId, name: String(network.Name ?? input.name ?? networkId) } };
    }
    case "volume.list": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.listVolumes(endpointId) };
    }
    case "volume.inspect": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const volumeName = requireText(input.volume_name ?? input.name, "volume_name", workflow);
      return { workflow, result: await client.inspectVolume(endpointId, volumeName) };
    }
    case "volume.create": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const name = requireText(input.volume_name ?? input.name, "volume_name", workflow);
      return {
        workflow,
        result: await client.createVolume(endpointId, {
          Name: name,
          ...(typeof input.driver === "string" && input.driver.trim() ? { Driver: input.driver.trim() } : {}),
          ...(input.labels ? { Labels: input.labels } : {}),
          ...(input.options ? { DriverOpts: input.options } : {}),
        }),
      };
    }
    case "volume.delete": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      const volumeName = requireText(input.volume_name ?? input.name, "volume_name", workflow);
      await client.deleteVolume(endpointId, volumeName, input.force === true);
      return { workflow, result: { ok: true, endpoint_id: endpointId, volume_name: volumeName } };
    }
    case "volume.prune": {
      const endpointId = requirePositiveInt(input.endpoint_id, "endpoint_id", workflow);
      return { workflow, result: await client.pruneVolumes(endpointId) };
    }
    default: {
      const exhaustive: never = workflow;
      throw new Error(`Unsupported Portainer workflow: ${exhaustive}`);
    }
  }
}
