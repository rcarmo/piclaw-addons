import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getChatJid } from "./compat/chat-context.js";
import { registerToolStatusHintProvider } from "./compat/tool-status-hints.js";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import type {
  ProxmoxConfig,
  ProxmoxConfigClearResult,
  ProxmoxConfigSetResult,
} from "./compat/types.js";
import {
  discoverProxmoxInstances,
  requestProxmoxApi,
  runProxmoxWorkflow,
  type ProxmoxApiConfig,
  type ProxmoxApiMethod,
  type ProxmoxWorkflowName,
  type ProxmoxWorkflowRequest,
  type ProxmoxWorkflowResponse,
} from "./client.js";
import {
  appendOutputFileNote,
  runRequestBatch,
  writeRequestOutputFile,
} from "./compat/request-batch.js";
import { presentStructuredToolValue } from "./compat/structured-tool-response.js";

type SessionProxmoxConfigInput = Omit<ProxmoxConfig, "chat_jid" | "created_at" | "updated_at">;
type ProxmoxToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

interface ProxmoxSettingsConfig {
  host: string;
  base_url: string;
  username: string;
  api_token_keychain: string;
  allow_insecure_tls: boolean;
}

interface ResolvedProxmoxConfigState {
  stored_config: ProxmoxConfig | null;
  settings_config: ProxmoxSettingsConfig;
  effective_config: ProxmoxApiConfig | null;
  source: "session" | "settings" | "merged" | "none";
}

const DEFAULT_PROXMOX_TOKEN_KEYCHAIN = process.env.PICLAW_PROXMOX_TOKEN_KEYCHAIN?.trim() || "proxmox/piclaw-management-token";
const DEFAULT_PROXMOX_PORT = process.env.PICLAW_PROXMOX_PORT?.trim() || "8006";
const DEFAULT_PROXMOX_SETTINGS: ProxmoxSettingsConfig = {
  host: "",
  base_url: "",
  username: "",
  api_token_keychain: DEFAULT_PROXMOX_TOKEN_KEYCHAIN,
  allow_insecure_tls: true,
};

export interface ProxmoxRequestResult {
  status: number;
  method: string;
  path: string;
  body: unknown;
}

export interface ProxmoxToolHandlers {
  get(chatJid: string): ProxmoxConfig | null;
  set(chatJid: string, config: SessionProxmoxConfigInput): Promise<ProxmoxConfigSetResult>;
  clear(chatJid: string): Promise<ProxmoxConfigClearResult>;
  request(
    chatJid: string,
    input: {
      method: string;
      path: string;
      query?: unknown;
      body?: unknown;
      body_mode?: "form" | "json";
    },
  ): Promise<ProxmoxRequestResult>;
  workflow(chatJid: string, input: ProxmoxWorkflowRequest): Promise<ProxmoxWorkflowResponse>;
}

let registeredHandlers: ProxmoxToolHandlers | null = null;
let kvStorage: ExtensionStorage | null = null;

function getStorage(): ExtensionStorage {
  if (!kvStorage) kvStorage = createExtensionStorage("proxmox");
  return kvStorage;
}

function kvGetConfig(chatJid: string): ProxmoxConfig | null {
  return getStorage().get<ProxmoxConfig>("config", "chat", chatJid);
}

function kvSetConfig(chatJid: string, config: SessionProxmoxConfigInput): ProxmoxConfigSetResult {
  const previous = kvGetConfig(chatJid);
  const timestamp = new Date().toISOString();
  const full: ProxmoxConfig = {
    chat_jid: chatJid,
    base_url: typeof config.base_url === "string" ? config.base_url.trim() : "",
    username: typeof config.username === "string" ? config.username.trim() : "",
    api_token_keychain: typeof config.api_token_keychain === "string" ? config.api_token_keychain.trim() : "",
    allow_insecure_tls: config.allow_insecure_tls,
    created_at: previous?.created_at || timestamp,
    updated_at: timestamp,
  };
  getStorage().set("config", full, "chat", chatJid);
  return { config: full, apply_timing: "immediate" };
}

function kvClearConfig(chatJid: string): ProxmoxConfigClearResult {
  const deleted = getStorage().delete("config", "chat", chatJid);
  return { deleted, apply_timing: "immediate" };
}

export function normalizeProxmoxBaseUrlInput(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      url.pathname = url.pathname === "/" || !url.pathname ? "/api2/json" : url.pathname.replace(/\/+$/, "");
      if (url.pathname === "/api2") url.pathname = "/api2/json";
      if (!url.pathname.endsWith("/api2/json")) url.pathname = "/api2/json";
      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/+$/, "");
    } catch {
      return trimmed;
    }
  }

  const host = trimmed.replace(/^\/+/, "").replace(/\/+$/, "");
  return `https://${host}:${DEFAULT_PROXMOX_PORT}/api2/json`;
}

export function deriveProxmoxHostInput(value: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.hostname || url.host || "";
  } catch {
    return trimmed.replace(/^https?:\/\//i, "").replace(/\/api2\/json.*$/i, "").replace(/\/.*$/, "");
  }
}

function loadProxmoxSettingsConfig(): ProxmoxSettingsConfig {
  try {
    const saved = getStorage().get<Partial<ProxmoxSettingsConfig>>("settings", "global") || {};
    const base_url = normalizeProxmoxBaseUrlInput(
      typeof saved.base_url === "string" && saved.base_url.trim()
        ? saved.base_url
        : (typeof saved.host === "string" ? saved.host : ""),
    );
    const host = typeof saved.host === "string" && saved.host.trim()
      ? saved.host.trim()
      : deriveProxmoxHostInput(base_url);
    return {
      ...DEFAULT_PROXMOX_SETTINGS,
      ...saved,
      host,
      base_url,
      username: typeof saved.username === "string" ? saved.username.trim() : "",
      api_token_keychain: typeof saved.api_token_keychain === "string" && saved.api_token_keychain.trim()
        ? saved.api_token_keychain.trim()
        : DEFAULT_PROXMOX_TOKEN_KEYCHAIN,
      allow_insecure_tls: saved.allow_insecure_tls ?? DEFAULT_PROXMOX_SETTINGS.allow_insecure_tls,
    };
  } catch {
    return { ...DEFAULT_PROXMOX_SETTINGS };
  }
}

function saveProxmoxSettingsConfig(patch: Partial<ProxmoxSettingsConfig>): ProxmoxSettingsConfig {
  const current = loadProxmoxSettingsConfig();
  const hasHost = Object.prototype.hasOwnProperty.call(patch, "host");
  const hasBaseUrl = Object.prototype.hasOwnProperty.call(patch, "base_url");
  const nextHostInput = hasHost ? String(patch.host || "").trim() : current.host;
  const nextBaseUrl = hasBaseUrl
    ? normalizeProxmoxBaseUrlInput(String(patch.base_url || ""))
    : hasHost
      ? normalizeProxmoxBaseUrlInput(nextHostInput)
      : current.base_url;

  const next: ProxmoxSettingsConfig = {
    host: nextHostInput || deriveProxmoxHostInput(nextBaseUrl),
    base_url: nextBaseUrl,
    username: typeof patch.username === "string" ? patch.username.trim() : current.username,
    api_token_keychain: typeof patch.api_token_keychain === "string"
      ? (patch.api_token_keychain.trim() || DEFAULT_PROXMOX_TOKEN_KEYCHAIN)
      : current.api_token_keychain,
    allow_insecure_tls: patch.allow_insecure_tls ?? current.allow_insecure_tls,
  };
  getStorage().set("settings", next, "global");
  return next;
}

function hasConfiguredSettings(settings: ProxmoxSettingsConfig): boolean {
  return Boolean(
    settings.base_url
    || settings.username
    || (settings.api_token_keychain && settings.api_token_keychain !== DEFAULT_PROXMOX_TOKEN_KEYCHAIN)
    || settings.allow_insecure_tls !== DEFAULT_PROXMOX_SETTINGS.allow_insecure_tls,
  );
}

function resolveApiConfig(chatJid: string): ProxmoxApiConfig | null {
  return resolveProxmoxConfigState(chatJid).effective_config;
}

function resolveProxmoxConfigState(chatJid: string, storedOverride?: ProxmoxConfig | null): ResolvedProxmoxConfigState {
  const stored_config = storedOverride === undefined ? kvGetConfig(chatJid) : storedOverride;
  const settings_config = loadProxmoxSettingsConfig();
  const base_url = readTrimmedString(stored_config?.base_url, settings_config.base_url);
  const username = readTrimmedString(stored_config?.username, settings_config.username);
  const api_token_keychain = readTrimmedString(stored_config?.api_token_keychain, settings_config.api_token_keychain);
  const allow_insecure_tls = stored_config?.allow_insecure_tls ?? settings_config.allow_insecure_tls ?? true;
  const effective_config = base_url && username && api_token_keychain
    ? { base_url, username, api_token_keychain, allow_insecure_tls }
    : null;
  const source = stored_config
    ? (hasConfiguredSettings(settings_config) ? "merged" : "session")
    : effective_config
      ? "settings"
      : "none";

  return {
    stored_config,
    settings_config,
    effective_config,
    source,
  };
}

function handleGetProxmoxSettings(): ProxmoxSettingsConfig {
  return loadProxmoxSettingsConfig();
}

function handleSetProxmoxSettings(body: Partial<ProxmoxSettingsConfig>): { ok: true; config: ProxmoxSettingsConfig } {
  return { ok: true, config: saveProxmoxSettingsConfig(body) };
}

type AddonConfigApiRegistrar = (
  addonId: string,
  action: string,
  handlers: { get?: (payload: unknown, req: Request) => unknown | Promise<unknown>; set?: (payload: unknown, req: Request) => unknown | Promise<unknown> },
  extensionPath?: string,
) => "created" | "updated";

const registerAddonConfigApi = (globalThis as Record<string, unknown>).__piclaw_registerAddonConfigApi as AddonConfigApiRegistrar | undefined;
if (typeof registerAddonConfigApi === "function") {
  registerAddonConfigApi("proxmox", "config", {
    get: async () => handleGetProxmoxSettings(),
    set: async (payload) => handleSetProxmoxSettings((payload && typeof payload === "object" ? payload : {}) as Partial<ProxmoxSettingsConfig>),
  }, import.meta.dir);
}

async function kvRequest(chatJid: string, input: { method: string; path: string; query?: unknown; body?: unknown; body_mode?: "form" | "json"; timeout_ms?: number }): Promise<ProxmoxRequestResult> {
  const apiConfig = resolveApiConfig(chatJid);
  if (!apiConfig) throw new Error(`No usable Proxmox config for ${chatJid}. Use action=set or fill in the Proxmox addon settings.`);
  const response = await requestProxmoxApi(apiConfig, {
    method: input.method as ProxmoxApiMethod,
    path: input.path,
    query: input.query,
    body: input.body,
    body_mode: input.body_mode as "form" | "json" | undefined,
    timeout_ms: input.timeout_ms,
  });
  return { status: response.status, method: input.method, path: input.path, body: response.body };
}

async function kvWorkflow(chatJid: string, input: ProxmoxWorkflowRequest): Promise<ProxmoxWorkflowResponse> {
  const apiConfig = resolveApiConfig(chatJid);
  if (!apiConfig) throw new Error(`No usable Proxmox config for ${chatJid}. Use action=set or fill in the Proxmox addon settings.`);
  return runProxmoxWorkflow(apiConfig, input);
}

const PROXMOX_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="4" y="4" width="16" height="6" rx="1.5"></rect><rect x="4" y="14" width="16" height="6" rx="1.5"></rect><path d="M8 7h.01M8 17h.01"></path><path d="M11 7h5M11 17h5"></path></svg>`;

function readTrimmedString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function extractHostLabelFromUrl(value: unknown): string | null {
  const raw = readTrimmedString(value);
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    const withoutProtocol = raw.replace(/^[a-z]+:\/\//i, "");
    return withoutProtocol.split("/")[0]?.trim() || null;
  }
}

export function setProxmoxToolHandlers(handlers: ProxmoxToolHandlers | null | undefined): void {
  registeredHandlers = handlers ?? null;
}

registerToolStatusHintProvider({
  id: "proxmox",
  buildHints: ({ chatJid, toolName, args }) => {
    if (toolName !== "proxmox") return null;
    const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
    const host = extractHostLabelFromUrl(
      readTrimmedString(
        record?.base_url,
        record?.baseUrl,
        record?.url,
        record?.endpoint,
        registeredHandlers?.get(chatJid)?.base_url ?? resolveProxmoxConfigState(chatJid).effective_config?.base_url,
      ),
    );
    if (!host) return null;
    return {
      key: "proxmox",
      icon_svg: PROXMOX_STATUS_ICON_SVG,
      label: host,
      title: "Proxmox host",
      kind: "service",
    };
  },
});

const ProxmoxWorkflowSchema = Type.Union([
  Type.Literal("cluster.status"),
  Type.Literal("vm.resolve_node"),
  Type.Literal("vm.status"),
  Type.Literal("vm.inspect"),
  Type.Literal("vm.create"),
  Type.Literal("vm.start"),
  Type.Literal("vm.stop"),
  Type.Literal("vm.resume"),
  Type.Literal("vm.restart"),
  Type.Literal("vm.ip"),
  Type.Literal("vm.migrate"),
  Type.Literal("vm.iso.attach"),
  Type.Literal("vm.iso.detach"),
  Type.Literal("vm.disk.resize"),
  Type.Literal("vm.disk.detach"),
  Type.Literal("vm.disk.remove"),
  Type.Literal("lxc.resolve_node"),
  Type.Literal("lxc.status"),
  Type.Literal("lxc.inspect"),
  Type.Literal("lxc.create"),
  Type.Literal("lxc.start"),
  Type.Literal("lxc.stop"),
  Type.Literal("lxc.restart"),
  Type.Literal("lxc.ip"),
  Type.Literal("node.list"),
  Type.Literal("node.inspect"),
  Type.Literal("node.log"),
  Type.Literal("node.reboot"),
  Type.Literal("node.shutdown"),
  Type.Literal("storage.list"),
  Type.Literal("storage.inspect"),
  Type.Literal("storage.content.list"),
  Type.Literal("storage.create"),
  Type.Literal("storage.download_url"),
  Type.Literal("backup.list"),
  Type.Literal("backup.create"),
  Type.Literal("backup.restore"),
  Type.Literal("task.list"),
  Type.Literal("task.status"),
  Type.Literal("task.log"),
  Type.Literal("task.wait"),
  Type.Literal("vm.wait_state"),
  Type.Literal("vm.snapshot.list"),
  Type.Literal("vm.snapshot.create"),
  Type.Literal("vm.snapshot.rollback"),
  Type.Literal("vm.snapshot.delete"),
  Type.Literal("vm.clone"),
  Type.Literal("vm.template.create"),
  Type.Literal("vm.agent.exec"),
  Type.Literal("vm.agent.osinfo"),
  Type.Literal("vm.agent.fsinfo"),
  Type.Literal("vm.agent.users"),
  Type.Literal("metrics.node"),
  Type.Literal("metrics.vm"),
  Type.Literal("metrics.storage"),
], { description: "Named higher-level Proxmox workflow to run." });

const ProxmoxWorkflowTargetSchema = Type.Object({
  status: Type.Optional(Type.String({ description: "Desired VM status for vm.wait_state." })),
  qmpstatus: Type.Optional(Type.String({ description: "Desired VM qmpstatus for vm.wait_state." })),
});

const ProxmoxRawRequestItemSchema = Type.Object({
  label: Type.Optional(Type.String({ description: "Optional label for one request in a batch." })),
  method: Type.Optional(Type.String({ description: "HTTP method for this batched request (defaults to GET)." })),
  path: Type.String({ description: "Relative Proxmox API path for this batched request." }),
  query: Type.Optional(Type.Any({ description: "Optional query-string parameters for this batched request." })),
  body: Type.Optional(Type.Any({ description: "Optional request body for this batched request." })),
  body_mode: Type.Optional(Type.Union([
    Type.Literal("form"),
    Type.Literal("json"),
  ], { description: "How to encode the request body for this batched request." })),
});

const ProxmoxToolSchema = Type.Object({
  action: Type.Union([
    Type.Literal("get"),
    Type.Literal("set"),
    Type.Literal("clear"),
    Type.Literal("discover"),
    Type.Literal("contract"),
    Type.Literal("capabilities"),
    Type.Literal("workflow_help"),
    Type.Literal("request_help"),
    Type.Literal("recommend"),
    Type.Literal("request"),
    Type.Literal("workflow"),
  ], {
    description: "Operation to perform for the current chat Proxmox config, API request, or workflow.",
  }),
  chat_jid: Type.Optional(Type.String({ description: "Target chat JID. Defaults to the current chat context." })),
  base_url: Type.Optional(Type.String({ description: "Proxmox API base URL, typically ending in /api2/json. Bare hosts/IPs should be configured in the addon settings pane." })),
  username: Type.Optional(Type.String({ description: "Proxmox API token username, e.g. root@pam!piclaw." })),
  api_token_keychain: Type.Optional(Type.String({ description: "Keychain entry containing the Proxmox API token secret." })),
  allow_insecure_tls: Type.Optional(Type.Boolean({ description: "Allow insecure/self-signed TLS when calling the API." })),
  method: Type.Optional(Type.String({ description: "HTTP method for action=request (GET, POST, PUT, DELETE)." })),
  path: Type.Optional(Type.String({ description: "Relative Proxmox API path for action=request." })),
  query: Type.Optional(Type.Any({ description: "Optional query-string parameters for action=request." })),
  body: Type.Optional(Type.Any({ description: "Optional request body for action=request." })),
  body_mode: Type.Optional(Type.Union([
    Type.Literal("form"),
    Type.Literal("json"),
  ], { description: "How to encode the request body for action=request." })),
  requests: Type.Optional(Type.Array(ProxmoxRawRequestItemSchema, { description: "Optional sequential batch of raw Proxmox requests for action=request. When provided, path/method/body/query apply per item instead of globally." })),
  pause_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Fixed pause between sequential batched requests." })),
  throttle_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Minimum spacing between the start of batched request attempts, including retries." })),
  retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Retry count for batched raw requests on retriable failures." })),
  retry_delay_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Initial delay before retrying a failed batched request." })),
  retry_backoff_factor: Type.Optional(Type.Number({ minimum: 1, description: "Backoff multiplier applied to retry_delay_ms for each additional retry." })),
  fail_fast: Type.Optional(Type.Boolean({ description: "Stop a batched request sequence after the first non-retriable or exhausted failure. Defaults to true." })),
  output_path: Type.Optional(Type.String({ description: "Optional workspace-relative output file path for action=request results." })),
  output_format: Type.Optional(Type.Union([
    Type.Literal("json"),
    Type.Literal("jsonl"),
  ], { description: "Optional output file format for action=request results (default json)." })),
  workflow: Type.Optional(ProxmoxWorkflowSchema),
  category: Type.Optional(Type.String({ description: "Optional workflow family/category filter for action=capabilities or action=recommend." })),
  include_workflows: Type.Optional(Type.Boolean({ description: "Include detailed workflow entries for action=capabilities. Defaults to false unless category is set." })),
  include_examples: Type.Optional(Type.Boolean({ description: "Include generated example payloads for action=workflow_help." })),
  intent: Type.Optional(Type.String({ description: "Short goal description for action=recommend, e.g. 'restore a VM from backup' or 'find task logs'." })),
  max_recommendations: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum workflow recommendations for action=recommend (default 3)." })),
  vmid: Type.Optional(Type.Integer({ minimum: 1, description: "VMID for VM/LXC workflows and provisioning flows." })),
  node: Type.Optional(Type.String({ description: "Optional Proxmox node override for VM/LXC/task workflows, or required node for create/download flows." })),
  storage: Type.Optional(Type.String({ description: "Storage name for storage/backup workflows and metrics.storage." })),
  upid: Type.Optional(Type.String({ description: "UPID for task.wait workflows." })),
  backup_volid: Type.Optional(Type.String({ description: "Backup volid/archive identifier for backup.restore." })),
  storage_type: Type.Optional(Type.String({ description: "Cluster storage type for storage.create, e.g. dir/nfs/lvmthin/zfspool." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Workflow timeout in milliseconds." })),
  poll_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Workflow polling interval in milliseconds." })),
  force: Type.Optional(Type.Boolean({ description: "Force option for workflows such as vm.stop or lxc.stop." })),
  target: Type.Optional(ProxmoxWorkflowTargetSchema),
  timeframe: Type.Optional(Type.String({ description: "Metrics timeframe for metrics workflows, e.g. hour/day/week." })),
  cf: Type.Optional(Type.String({ description: "Consolidation function for metrics workflows, e.g. AVERAGE or MAX." })),
  metric: Type.Optional(Type.String({ description: "Single metric key to retain from metrics workflow results." })),
  metrics: Type.Optional(Type.Array(Type.String(), { description: "Multiple metric keys to retain from metrics workflow results." })),
  snapshot_name: Type.Optional(Type.String({ description: "Snapshot name for vm.snapshot.* workflows." })),
  description: Type.Optional(Type.String({ description: "Optional description for snapshot/clone workflows." })),
  name: Type.Optional(Type.String({ description: "Optional VM name for vm.create." })),
  hostname: Type.Optional(Type.String({ description: "Optional hostname for lxc.create." })),
  memory: Type.Optional(Type.Integer({ minimum: 1, description: "Memory in MiB for create workflows." })),
  cores: Type.Optional(Type.Integer({ minimum: 1, description: "Core count for create workflows." })),
  sockets: Type.Optional(Type.Integer({ minimum: 1, description: "Socket count for vm.create." })),
  ostype: Type.Optional(Type.String({ description: "Optional guest OS type for vm.create." })),
  net0: Type.Optional(Type.String({ description: "Optional net0 config string for create workflows." })),
  ostemplate: Type.Optional(Type.String({ description: "Template volid for lxc.create." })),
  rootfs: Type.Optional(Type.String({ description: "Rootfs storage spec for lxc.create, e.g. local-lvm:8." })),
  password: Type.Optional(Type.String({ description: "Optional initial root password for lxc.create." })),
  ssh_public_keys: Type.Optional(Type.String({ description: "Optional SSH public keys payload for lxc.create." })),
  unprivileged: Type.Optional(Type.Boolean({ description: "Whether lxc.create should create an unprivileged container." })),
  config: Type.Optional(Type.Any({ description: "Advanced extra form fields merged into create/storage workflows for Proxmox-native parameters like scsi0, net1, or backend-specific storage options." })),
  newid: Type.Optional(Type.Integer({ minimum: 1, description: "Target VMID for vm.clone." })),
  new_name: Type.Optional(Type.String({ description: "Optional new VM name for vm.clone." })),
  target_node: Type.Optional(Type.String({ description: "Optional target node for vm.clone." })),
  target_storage: Type.Optional(Type.String({ description: "Optional target storage for vm.clone." })),
  full: Type.Optional(Type.Boolean({ description: "Whether vm.clone should be a full clone." })),
  online: Type.Optional(Type.Boolean({ description: "Whether vm.migrate should attempt online migration." })),
  with_local_disks: Type.Optional(Type.Boolean({ description: "Whether vm.migrate should include local disks." })),
  mode: Type.Optional(Type.String({ description: "Backup mode for backup.create, e.g. snapshot/stop/suspend." })),
  compress: Type.Optional(Type.String({ description: "Compression mode for backup.create." })),
  slot: Type.Optional(Type.String({ description: "Target VM bus slot for ISO attach/detach, e.g. ide2 or sata1." })),
  iso_volume: Type.Optional(Type.String({ description: "Existing ISO volid to mount, e.g. local:iso/debian.iso." })),
  disk: Type.Optional(Type.String({ description: "Disk or mount identifier for disk workflows, e.g. scsi0, virtio0, rootfs, or mp0." })),
  size: Type.Optional(Type.String({ description: "New size for resize workflows, e.g. +10G or 64G." })),
  unlink: Type.Optional(Type.Boolean({ description: "Whether removal should physically unlink the disk image where supported." })),
  download_url: Type.Optional(Type.String({ description: "Public URL for storage.download_url." })),
  filename: Type.Optional(Type.String({ description: "Destination filename for storage.download_url." })),
  content: Type.Optional(Type.String({ description: "Content type for storage.download_url, e.g. iso/vztmpl/import." })),
  checksum: Type.Optional(Type.String({ description: "Optional expected checksum for storage.download_url." })),
  checksum_algorithm: Type.Optional(Type.String({ description: "Checksum algorithm for storage.download_url, e.g. sha256." })),
  compression: Type.Optional(Type.String({ description: "Optional decompression algorithm for storage.download_url." })),
  verify_certificates: Type.Optional(Type.Boolean({ description: "Verify TLS certificates for storage.download_url (default true in Proxmox)." })),
  command: Type.Optional(Type.String({ description: "Guest-agent command for vm.agent.exec." })),
  command_args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments for vm.agent.exec." })),
  input_data: Type.Optional(Type.String({ description: "Optional stdin payload for vm.agent.exec." })),
  shell_family: Type.Optional(Type.Union([
    Type.Literal("posix"),
    Type.Literal("powershell"),
  ], { description: "Shell wrapper family for exec-style workflows like vm.agent.exec." })),
  limit: Type.Optional(Type.Integer({ minimum: 1, description: "Result limit for workflows like task.list." })),
  lines: Type.Optional(Type.Integer({ minimum: 1, description: "Line count for node.log." })),
});

type WorkflowCapabilitySpec = {
  category: string;
  summary: string;
  required_fields: string[];
  optional_fields?: string[];
  mutating?: boolean;
  destructive?: boolean;
  recommended_for?: string[];
  see_also?: string[];
  guidance?: string[];
  example_fields?: Record<string, unknown>;
};

type WorkflowFamilySummary = {
  name: string;
  summary: string;
  workflow_count: number;
  mutating_workflow_count: number;
  destructive_workflow_count: number;
};

const PROXMOX_WORKFLOW_FAMILY_SUMMARIES: Record<string, string> = {
  backup: "Backup creation, restore, and backup inventory workflows.",
  cluster: "Cluster-wide health and status inspection.",
  "guest-agent": "In-guest inspection and bounded command execution via the QEMU guest agent.",
  lxc: "LXC lifecycle, provisioning, inspection, and guest-network workflows.",
  metrics: "RRD metrics for nodes, VMs, and storage.",
  node: "Node inventory and inspection workflows.",
  storage: "Storage inventory, creation, content browsing, and URL download workflows.",
  task: "Async task inspection, logs, and wait flows.",
  vm: "QEMU VM lifecycle, provisioning, media, disk, snapshot, migration, clone, and template workflows.",
};

const PROXMOX_WORKFLOW_CAPABILITIES: Record<string, WorkflowCapabilitySpec> = {
  "cluster.status": { category: "cluster", summary: "List cluster status entries.", required_fields: [] },
  "node.list": { category: "node", summary: "List Proxmox nodes.", required_fields: [] },
  "node.inspect": { category: "node", summary: "Inspect a node status payload.", required_fields: ["node"] },
  "node.log": { category: "node", summary: "Read recent node syslog entries.", required_fields: ["node"], optional_fields: ["lines", "limit"], recommended_for: ["reading recent node logs", "debugging host-side Proxmox issues"] },
  "node.reboot": { category: "node", summary: "Request a node reboot.", required_fields: ["node"], mutating: true, destructive: true, recommended_for: ["planned node maintenance windows"], guidance: ["This is disruptive. Expect the node to become temporarily unavailable after the request is accepted."] },
  "node.shutdown": { category: "node", summary: "Request a node shutdown.", required_fields: ["node"], mutating: true, destructive: true, recommended_for: ["planned node shutdowns"], guidance: ["This is disruptive. Ensure workloads are evacuated or stopped first."] },
  "storage.list": { category: "storage", summary: "List storages globally or for one node.", required_fields: [], optional_fields: ["node"] },
  "storage.inspect": { category: "storage", summary: "Inspect one storage status payload.", required_fields: ["node", "storage"] },
  "storage.content.list": { category: "storage", summary: "List content inside a storage.", required_fields: ["node", "storage"], recommended_for: ["finding ISOs, backups, or snippets on a storage"] },
  "storage.create": { category: "storage", summary: "Create a cluster storage definition using a storage type plus backend-specific config.", required_fields: ["storage", "storage_type"], optional_fields: ["config"], mutating: true, recommended_for: ["adding new Proxmox storage definitions"], guidance: ["Use config to pass backend-specific fields such as path, server, export, pool, vgname, nodes, or content."] },
  "storage.download_url": { category: "storage", summary: "Download a public URL directly into storage as ISO, template, or import content.", required_fields: ["node", "storage", "download_url", "filename"], optional_fields: ["content", "checksum", "checksum_algorithm", "compression", "verify_certificates", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["pulling ISO media directly into storage", "fetching public templates without agent-side upload"] },
  "backup.list": { category: "backup", summary: "List backup artifacts in a storage.", required_fields: ["node", "storage"], recommended_for: ["verifying backup inventory before restore or cleanup"] },
  "backup.create": { category: "backup", summary: "Create a vzdump backup for a VM.", required_fields: ["node", "vmid", "storage"], optional_fields: ["mode", "compress", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["pre-maintenance backups", "one-off VM protection before risky changes"], guidance: ["Consider backup.list or storage.content.list to verify the target storage before and after the backup."] },
  "backup.restore": { category: "backup", summary: "Restore a VM from a backup volid/archive.", required_fields: ["node", "storage", "backup_volid", "vmid"], optional_fields: ["target_storage", "timeout_ms", "poll_ms"], mutating: true, destructive: true, recommended_for: ["restoring a VM from backup", "recovering workloads onto a target node"], guidance: ["Use backup.list first to find the archive/volid you want to restore.", "Provide target_storage when the restore destination should differ from the source backup storage."] },
  "vm.resolve_node": { category: "vm", summary: "Resolve the node hosting a QEMU VM.", required_fields: ["vmid"], recommended_for: ["finding the current node before raw API work"] },
  "vm.status": { category: "vm", summary: "Read QEMU VM runtime status.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.inspect": { category: "vm", summary: "Read QEMU VM status plus config.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.create": { category: "vm", summary: "Create a new QEMU VM using common fields plus optional Proxmox config overrides.", required_fields: ["node", "vmid"], optional_fields: ["name", "memory", "cores", "sockets", "ostype", "net0", "slot", "iso_volume", "config", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["provisioning a new VM", "creating a VM with installer media already attached"], guidance: ["Use config for advanced Proxmox create fields such as scsi0, virtio0, agent, machine, bios, or additional NICs."] },
  "vm.start": { category: "vm", summary: "Start a QEMU VM and wait for running state.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true },
  "vm.stop": { category: "vm", summary: "Stop a QEMU VM, optionally forcing the stop.", required_fields: ["vmid"], optional_fields: ["node", "force", "timeout_ms", "poll_ms"], mutating: true, destructive: true },
  "vm.resume": { category: "vm", summary: "Resume a suspended QEMU VM or start it if needed.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true },
  "vm.restart": { category: "vm", summary: "Restart a QEMU VM.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true },
  "vm.ip": { category: "vm", summary: "Read VM IPs through the QEMU guest agent.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.migrate": { category: "vm", summary: "Migrate a QEMU VM to another node.", required_fields: ["vmid", "target_node"], optional_fields: ["node", "target_storage", "online", "with_local_disks", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["planned node evacuation", "moving workloads during maintenance windows"] },
  "vm.iso.attach": { category: "vm", summary: "Attach an existing ISO volid to a VM cdrom slot.", required_fields: ["vmid", "iso_volume"], optional_fields: ["node", "slot", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["mounting installer media on an existing VM"] },
  "vm.iso.detach": { category: "vm", summary: "Detach an ISO/cdrom slot from a VM.", required_fields: ["vmid"], optional_fields: ["node", "slot", "timeout_ms", "poll_ms"], mutating: true },
  "vm.disk.resize": { category: "vm", summary: "Extend a VM disk volume.", required_fields: ["vmid", "disk", "size"], optional_fields: ["node"], mutating: true, recommended_for: ["growing VM disks without moving them"] },
  "vm.disk.detach": { category: "vm", summary: "Detach a VM disk from the VM config without physically deleting the backing volume.", required_fields: ["vmid", "disk"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true, destructive: true },
  "vm.disk.remove": { category: "vm", summary: "Physically remove a VM disk volume through the unlink endpoint.", required_fields: ["vmid", "disk"], optional_fields: ["node", "force", "timeout_ms", "poll_ms"], mutating: true, destructive: true, recommended_for: ["permanently deleting detached or attached VM disks"] },
  "vm.wait_state": { category: "vm", summary: "Wait for a VM to reach a target status/qmpstatus.", required_fields: ["vmid", "target"], optional_fields: ["node", "timeout_ms", "poll_ms"] },
  "vm.snapshot.list": { category: "vm", summary: "List VM snapshots.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.snapshot.create": { category: "vm", summary: "Create a VM snapshot.", required_fields: ["vmid", "snapshot_name"], optional_fields: ["node", "description", "timeout_ms", "poll_ms"], mutating: true },
  "vm.snapshot.rollback": { category: "vm", summary: "Rollback a VM snapshot.", required_fields: ["vmid", "snapshot_name"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true, destructive: true },
  "vm.snapshot.delete": { category: "vm", summary: "Delete a VM snapshot.", required_fields: ["vmid", "snapshot_name"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true, destructive: true },
  "vm.clone": { category: "vm", summary: "Clone a VM to a new VMID.", required_fields: ["vmid", "newid"], optional_fields: ["node", "new_name", "target_node", "target_storage", "full", "description", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["creating a mutable copy before risky changes", "provisioning from an existing VM"] },
  "vm.template.create": { category: "vm", summary: "Mark a VM as a template.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["golden image preparation", "template conversion before clone-based provisioning"], guidance: ["Convert to a template only when you no longer need to boot the source as a normal mutable VM."] },
  "vm.agent.exec": { category: "guest-agent", summary: "Execute a bounded command through the QEMU guest agent.", required_fields: ["vmid", "command"], optional_fields: ["node", "command_args", "input_data", "shell_family", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["bounded in-guest checks without SSH", "one-off guest diagnostics"], guidance: ["Keep commands short and non-interactive; this workflow is not a streaming shell.", "Use shell_family=powershell for Windows guests and shell_family=posix for Linux/Unix guests."] },
  "vm.agent.osinfo": { category: "guest-agent", summary: "Read guest OS information.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.agent.fsinfo": { category: "guest-agent", summary: "Read guest filesystem information.", required_fields: ["vmid"], optional_fields: ["node"] },
  "vm.agent.users": { category: "guest-agent", summary: "Read logged-in guest users.", required_fields: ["vmid"], optional_fields: ["node"] },
  "lxc.resolve_node": { category: "lxc", summary: "Resolve the node hosting an LXC container.", required_fields: ["vmid"], recommended_for: ["finding the current node before raw API work"] },
  "lxc.status": { category: "lxc", summary: "Read LXC runtime status.", required_fields: ["vmid"], optional_fields: ["node"] },
  "lxc.inspect": { category: "lxc", summary: "Read LXC status plus config.", required_fields: ["vmid"], optional_fields: ["node"] },
  "lxc.create": { category: "lxc", summary: "Create a new LXC container using common fields plus optional Proxmox config overrides.", required_fields: ["node", "vmid"], optional_fields: ["hostname", "memory", "cores", "net0", "ostemplate", "rootfs", "password", "ssh_public_keys", "unprivileged", "config", "timeout_ms", "poll_ms"], mutating: true, recommended_for: ["provisioning a new LXC container"], guidance: ["Use config for advanced Proxmox CT create fields such as features, mp0, swap, nameserver, or startup."] },
  "lxc.start": { category: "lxc", summary: "Start an LXC container.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true },
  "lxc.stop": { category: "lxc", summary: "Stop an LXC container.", required_fields: ["vmid"], optional_fields: ["node", "force", "timeout_ms", "poll_ms"], mutating: true, destructive: true },
  "lxc.restart": { category: "lxc", summary: "Restart an LXC container.", required_fields: ["vmid"], optional_fields: ["node", "timeout_ms", "poll_ms"], mutating: true },
  "lxc.ip": { category: "lxc", summary: "Read LXC interface IPs.", required_fields: ["vmid"], optional_fields: ["node"] },
  "task.list": { category: "task", summary: "List tasks for a node, optionally filtered by VMID.", required_fields: ["node"], optional_fields: ["vmid", "limit"], recommended_for: ["finding recent task UPIDs before inspecting logs or waiting"] },
  "task.status": { category: "task", summary: "Inspect one task status payload.", required_fields: ["node", "upid"] },
  "task.log": { category: "task", summary: "Read the task log entries for a UPID.", required_fields: ["node", "upid"] },
  "task.wait": { category: "task", summary: "Wait for a UPID to stop.", required_fields: ["node", "upid"], optional_fields: ["timeout_ms", "poll_ms"] },
  "metrics.node": { category: "metrics", summary: "Read node RRD metrics.", required_fields: ["node"], optional_fields: ["timeframe", "cf", "metric", "metrics"], recommended_for: ["node charting", "capacity and load inspection"] },
  "metrics.vm": { category: "metrics", summary: "Read VM RRD metrics.", required_fields: ["vmid"], optional_fields: ["node", "timeframe", "cf", "metric", "metrics"], recommended_for: ["VM charting", "guest performance inspection"] },
  "metrics.storage": { category: "metrics", summary: "Read storage RRD metrics.", required_fields: ["node", "storage"], optional_fields: ["timeframe", "cf", "metric", "metrics"], recommended_for: ["storage utilization charting", "capacity inspection"] },
};

function resolveRuntimeProxmoxWorkflowName(value: string): ProxmoxWorkflowName {
  return value as ProxmoxWorkflowName;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function normalizeCategoryFilter(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getProxmoxWorkflowEntries(category?: string): Array<{ name: string } & WorkflowCapabilitySpec> {
  const entries = Object.entries(PROXMOX_WORKFLOW_CAPABILITIES)
    .map(([name, spec]) => ({ name, ...spec }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!category) return entries;
  const filtered = entries.filter((entry) => entry.category === category);
  if (filtered.length === 0) {
    throw new Error(`Unknown Proxmox workflow family: ${category}`);
  }
  return filtered;
}

function buildProxmoxFamilySummaries(): WorkflowFamilySummary[] {
  return Object.entries(PROXMOX_WORKFLOW_FAMILY_SUMMARIES)
    .map(([name, summary]) => {
      const entries = getProxmoxWorkflowEntries(name);
      return {
        name,
        summary,
        workflow_count: entries.length,
        mutating_workflow_count: entries.filter((entry) => entry.mutating === true).length,
        destructive_workflow_count: entries.filter((entry) => entry.destructive === true).length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getProxmoxDefaultRecommendedFor(category: string): string[] {
  switch (category) {
    case "vm":
      return ["day-2 lifecycle operations", "pre/post maintenance checks", "VM provisioning"];
    case "lxc":
      return ["day-2 lifecycle operations", "pre/post maintenance checks", "container provisioning"];
    case "node":
    case "storage":
      return ["infrastructure inventory", "health inspection", "storage provisioning"];
    case "cluster":
      return ["infrastructure inventory", "health inspection"];
    case "task":
      return ["tracking async operations", "debugging failed jobs"];
    case "metrics":
      return ["charting", "performance inspection"];
    case "backup":
      return ["backup operations", "change-safety preparation"];
    case "guest-agent":
      return ["in-guest inspection without SSH"];
    default:
      return [];
  }
}

function getProxmoxDefaultSeeAlso(workflow: string, category: string): string[] {
  switch (category) {
    case "vm":
      return ["vm.inspect", "vm.create", "vm.iso.attach", "vm.disk.resize", "metrics.vm"];
    case "lxc":
      return ["lxc.inspect", "lxc.create", "lxc.status", "lxc.resolve_node", "task.list"];
    case "task":
      return ["task.list", "task.status", "task.log", "task.wait"];
    case "storage":
      return ["storage.list", "storage.inspect", "storage.create", "storage.download_url", "metrics.storage"];
    case "backup":
      return ["backup.list", "backup.create", "backup.restore", "task.log", "task.wait"];
    case "guest-agent":
      return ["vm.ip", "vm.agent.osinfo", "vm.agent.fsinfo", "vm.agent.users"];
    case "metrics":
      return ["metrics.node", "metrics.vm", "metrics.storage"];
    case "node":
      return ["node.list", "node.inspect", "node.log", "node.reboot", "metrics.node"];
    default:
      return getProxmoxWorkflowEntries(category).map((entry) => entry.name);
  }
}

function getProxmoxDefaultGuidance(workflow: string, spec: WorkflowCapabilitySpec): string[] {
  const guidance = [...(spec.guidance || [])];
  if ((spec.category === "vm" || spec.category === "lxc") && spec.required_fields.includes("vmid") && spec.optional_fields?.includes("node")) {
    guidance.push(`If node is unknown, omit node and let ${workflow} resolve it automatically; use ${spec.category}.resolve_node when you need the placement first.`);
  }
  if ((workflow === "vm.create" || workflow === "lxc.create" || workflow === "storage.create") && spec.optional_fields?.includes("config")) {
    guidance.push("Use config only for backend-specific or advanced Proxmox parameters you do not want to model as first-class fields.");
  }
  if (workflow === "storage.download_url") {
    guidance.push("This is a server-side pull into storage, so it avoids agent-side file upload.");
  }
  if (spec.category === "task") {
    guidance.push("Use task.list first when the UPID is not yet known.");
  }
  if (spec.category === "metrics") {
    guidance.push("Use metric or metrics to trim returned series and keep results small.");
  }
  if (spec.mutating) {
    guidance.push("Inspect current state first if you need a pre-change snapshot.");
  }
  if (spec.destructive) {
    guidance.push("Double-check identifiers and scope before destructive workflows.");
  }
  return uniqueStrings(guidance);
}

function buildProxmoxRequiredFieldExample(field: string, workflow: string): unknown {
  switch (field) {
    case "vmid": return 117;
    case "node": return "pve";
    case "storage": return workflow.startsWith("backup.") ? "backup-store" : "local";
    case "upid": return "UPID:pve:00000001:00000001:00000001:task:root@pam:";
    case "backup_volid": return "backup-store:backup/vzdump-qemu-117.vma.zst";
    case "snapshot_name": return "pre-upgrade";
    case "name": return "vm117";
    case "hostname": return "ct201";
    case "memory": return 4096;
    case "cores": return 4;
    case "sockets": return 1;
    case "ostype": return "l26";
    case "net0": return "virtio,bridge=vmbr0";
    case "ostemplate": return "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst";
    case "rootfs": return "local-lvm:8";
    case "password": return "<password>";
    case "ssh_public_keys": return "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... user@example";
    case "storage_type": return "dir";
    case "slot": return "ide2";
    case "iso_volume": return "local:iso/debian-12.iso";
    case "disk": return workflow.startsWith("vm.disk") ? "scsi0" : "rootfs";
    case "size": return "+10G";
    case "download_url": return "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.10.0-amd64-netinst.iso";
    case "filename": return "debian-12.10.0-amd64-netinst.iso";
    case "content": return "iso";
    case "checksum": return "<checksum>";
    case "checksum_algorithm": return "sha256";
    case "compression": return "gz";
    case "newid": return 2117;
    case "target_node": return "pve2";
    case "target_storage": return "local-zfs";
    case "command": return "echo";
    case "target": return { status: "running" };
    case "timeframe": return "day";
    case "cf": return "AVERAGE";
    case "metric": return workflow === "metrics.storage" ? "used" : "cpu";
    case "metrics": return workflow === "metrics.storage" ? ["used", "total"] : ["cpu", "memused"];
    case "mode": return "snapshot";
    case "compress": return "zstd";
    case "limit": return 25;
    case "lines": return 100;
    case "config":
      return workflow === "vm.create"
        ? { scsi0: "local-lvm:32", agent: 1 }
        : workflow === "lxc.create"
          ? { features: "nesting=1" }
          : { path: "/srv/pve/iso", content: "iso,backup,vztmpl" };
    default: return `<${field}>`;
  }
}

function buildProxmoxCommonOptionalExample(workflow: string): Record<string, unknown> {
  switch (workflow) {
    case "vm.create":
      return { name: "vm117", memory: 4096, cores: 4, config: { scsi0: "local-lvm:32" }, slot: "ide2", iso_volume: "local:iso/debian-12.iso", timeout_ms: 120000, poll_ms: 2000 };
    case "lxc.create":
      return { hostname: "ct201", ostemplate: "local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst", rootfs: "local-lvm:8", unprivileged: true, timeout_ms: 120000, poll_ms: 2000 };
    case "storage.create":
      return { config: { path: "/srv/pve/iso", content: "iso,backup,vztmpl" } };
    case "storage.download_url":
      return { content: "iso", timeout_ms: 120000, poll_ms: 2000 };
    case "vm.iso.attach":
      return { slot: "ide2", timeout_ms: 120000, poll_ms: 2000 };
    case "vm.iso.detach":
      return { slot: "ide2", timeout_ms: 120000, poll_ms: 2000 };
    case "vm.disk.resize":
      return {};
    case "vm.disk.detach":
    case "vm.disk.remove":
      return { timeout_ms: 120000, poll_ms: 2000 };
    case "backup.create":
      return { mode: "snapshot", compress: "zstd", timeout_ms: 120000, poll_ms: 2000 };
    case "backup.restore":
      return { target_storage: "local-zfs", timeout_ms: 120000, poll_ms: 2000 };
    case "vm.start":
    case "vm.stop":
    case "vm.resume":
    case "vm.restart":
    case "lxc.start":
    case "lxc.stop":
    case "lxc.restart":
    case "task.wait":
      return { timeout_ms: 120000, poll_ms: 2000 };
    case "vm.wait_state":
      return { timeout_ms: 120000, poll_ms: 2000 };
    case "vm.snapshot.create":
      return { description: "pre-upgrade snapshot", timeout_ms: 120000, poll_ms: 2000 };
    case "vm.snapshot.rollback":
    case "vm.snapshot.delete":
    case "vm.template.create":
      return { timeout_ms: 120000, poll_ms: 2000 };
    case "vm.clone":
      return { new_name: "vm117-clone", target_node: "pve2", full: true };
    case "vm.migrate":
      return { online: true, timeout_ms: 120000, poll_ms: 2000 };
    case "vm.agent.exec":
      return { command_args: ["ok"], shell_family: "posix", timeout_ms: 30000, poll_ms: 1000 };
    case "metrics.node":
      return { timeframe: "day", metric: "cpu" };
    case "metrics.vm":
      return { timeframe: "day", metric: "cpu" };
    case "metrics.storage":
      return { timeframe: "day", metric: "used" };
    case "task.list":
      return { limit: 25 };
    case "node.log":
      return { lines: 100 };
    default:
      return {};
  }
}

function buildProxmoxWorkflowExamples(workflow: string, spec: WorkflowCapabilitySpec): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = { action: "workflow", workflow };
  for (const field of spec.required_fields) {
    base[field] = buildProxmoxRequiredFieldExample(field, workflow);
  }
  const common = { ...base, ...buildProxmoxCommonOptionalExample(workflow), ...(spec.example_fields || {}) };
  const serializedBase = JSON.stringify(base);
  const serializedCommon = JSON.stringify(common);
  return serializedBase === serializedCommon ? [base] : [base, common];
}

function buildProxmoxRequestExamples(): Array<Record<string, unknown>> {
  return [
    {
      action: "request",
      method: "GET",
      path: "/cluster/resources",
      query: { type: "vm" },
      purpose: "List VM/LXC cluster resources so you can resolve names, nodes, and VMIDs before charting or mutation.",
    },
    {
      action: "request",
      method: "GET",
      path: "/nodes/tnas/lxc/103/rrddata",
      query: { timeframe: "day", cf: "AVERAGE" },
      purpose: "Fetch 24h LXC RRD metrics for charting or comparison work.",
    },
    {
      action: "request",
      method: "POST",
      path: "/nodes/pve/storage/local/download-url",
      body_mode: "form",
      body: {
        content: "iso",
        filename: "debian-12.iso",
        url: "https://cdimage.debian.org/debian-cd/current/amd64/iso-cd/debian-12.10.0-amd64-netinst.iso",
      },
      purpose: "Server-side pull of public ISO media into storage.",
    },
    {
      action: "request",
      requests: [
        { label: "resources", method: "GET", path: "/cluster/resources", query: { type: "vm" } },
        { label: "metrics", method: "GET", path: "/nodes/pve/qemu/117/rrddata", query: { timeframe: "day", cf: "AVERAGE" } },
      ],
      throttle_ms: 250,
      retries: 2,
      retry_delay_ms: 1000,
      output_path: "exports/proxmox-request-batch.json",
      purpose: "Run a small sequential batch, keep spacing between attempts, and persist the combined result to a file.",
    },
  ];
}

function buildProxmoxRequestHelpPayload(): Record<string, unknown> {
  return {
    action: "request_help",
    request_contract: {
      summary: "Use request for raw Proxmox API calls when the workflow surface is too narrow or you need an endpoint such as RRD metrics/charting. Provide either path for one request or requests for a sequential batch.",
      required_fields: ["path or requests"],
      optional_fields: ["method", "query", "body", "body_mode", "requests", "pause_ms", "throttle_ms", "timeout_ms", "retries", "retry_delay_ms", "retry_backoff_factor", "fail_fast", "output_path", "output_format"],
      defaults: {
        method: "GET",
        body_mode: "form",
      },
      path_rules: [
        "path may be given with or without a leading slash; the runtime normalizes it against the configured /api2/json base URL.",
        "Use query for GET-style filters such as type=vm or timeframe=day.",
        "Use body + body_mode=json only for JSON-native endpoints; Proxmox form endpoints should stay in body_mode=form.",
        "Use requests for sequential batches; each item supports its own method/path/query/body/body_mode/label.",
        "Batched requests run sequentially with configurable pause_ms, throttle_ms, timeout_ms, retries, and retry_delay_ms.",
        "Use output_path to persist either a single request result or a full batch result to a workspace file.",
      ],
      response_shape: {
        content_text: "Success summary plus the full inline Response body when bounded, otherwise a tool-output handle/path plus preview.",
        details_path: "details.response",
        fields: {
          status: "HTTP status number",
          method: "normalized HTTP method",
          path: "normalized API path starting with /",
          body: "parsed JSON body when possible, otherwise raw text",
        },
        body_access_path: "details.response.body",
        batch_details_path: "details.batch",
        batch_results_access_path: "details.batch.results",
        overflow_tool_output_access_path: "details.response_tool_output or details.batch_tool_output",
        output_file_access_path: "details.output_file",
      },
      examples: buildProxmoxRequestExamples(),
      metrics_charting_patterns: [
        {
          goal: "Compare two guests by name using Proxmox metrics",
          steps: [
            "GET /cluster/resources?type=vm to resolve guest name → node/type/vmid.",
            "GET /nodes/{node}/{lxc|qemu}/{vmid}/rrddata?timeframe=day&cf=AVERAGE for each guest.",
            "Render the returned series locally into SVG/CSV/chart artifacts.",
          ],
        },
      ],
      next_steps: [
        "Use capabilities or recommend first if you are not sure whether a native workflow already exists.",
        "Use workflow_help for one workflow before falling back to request when the task fits a curated flow.",
      ],
    },
  };
}

function buildProxmoxContractPayload(): Record<string, unknown> {
  return {
    tool: "proxmox",
    actions: ["get", "set", "clear", "discover", "contract", "capabilities", "workflow_help", "request_help", "recommend", "request", "workflow"],
    shared_discovery_flow: [
      "discover",
      "capabilities or recommend",
      "workflow_help",
      "workflow or request",
    ],
    context_conservation: [
      "Use capabilities for family-level summaries before enumerating workflows.",
      "Use recommend for short intent-based shortlists.",
      "Set include_examples=true on workflow_help only when you need example payloads.",
      "Use request only when the curated workflow surface is not the right fit.",
    ],
    session_profile_contract: {
      get: ["chat_jid"],
      set: ["base_url", "username", "api_token_keychain", "allow_insecure_tls"],
      clear: ["chat_jid"],
      discover: ["addon settings", "env hints", "keychain hints"],
    },
    request_contract: buildProxmoxRequestHelpPayload().request_contract,
    workflow_contract: {
      discovery: "Use capabilities/recommend/workflow_help to choose one workflow before execution.",
      response_shape: {
        content_text: "Workflow completion summary plus the full inline Result when bounded, otherwise a tool-output handle/path plus preview.",
        details_path: "details.response",
        fields: {
          workflow: "canonical workflow name",
          vmid: "optional VM/LXC identifier when applicable",
          node: "optional resolved node",
          result: "workflow-specific result payload",
        },
        result_access_path: "details.response.result",
        overflow_tool_output_access_path: "details.result_tool_output",
      },
    },
  };
}

function buildProxmoxCapabilitiesPayload(options?: { category?: string; include_workflows?: boolean }): Record<string, unknown> {
  const category = normalizeCategoryFilter(options?.category);
  const familySummaries = buildProxmoxFamilySummaries();
  if (category && !familySummaries.some((entry) => entry.name === category)) {
    throw new Error(`Unknown Proxmox workflow family: ${category}`);
  }
  const includeWorkflows = options?.include_workflows === true || Boolean(category);
  const entries = includeWorkflows ? getProxmoxWorkflowEntries(category) : [];
  return {
    actions: ["get", "set", "clear", "discover", "contract", "capabilities", "workflow_help", "request_help", "recommend", "request", "workflow"],
    workflow_count: Object.keys(PROXMOX_WORKFLOW_CAPABILITIES).length,
    workflow_families: familySummaries.map((entry) => entry.name),
    family_summaries: category ? familySummaries.filter((entry) => entry.name === category) : familySummaries,
    ...(category ? { category } : {}),
    include_workflows: includeWorkflows,
    ...(includeWorkflows ? {
      matching_workflow_count: entries.length,
      workflows: entries.map(({ name, category: workflowCategory, summary, required_fields, optional_fields, mutating, destructive }) => ({
        name,
        category: workflowCategory,
        summary,
        required_fields,
        optional_fields: optional_fields || [],
        mutating: mutating === true,
        destructive: destructive === true,
      })),
    } : {}),
    next_steps: [
      "Set category to inspect one workflow family without pulling the whole surface.",
      "Use workflow_help with one workflow for required fields, guidance, and see_also suggestions.",
      "Use request_help when you need raw API request fields, response shape, or charting-oriented request examples.",
      "Set include_examples=true on workflow_help only when you need example payloads.",
    ],
  };
}

function getProxmoxWorkflowHelp(value: string | undefined, options?: { include_examples?: boolean }): { canonical_workflow: string; runtime_workflow: ProxmoxWorkflowName; spec: WorkflowCapabilitySpec; recommended_for: string[]; see_also: string[]; guidance: string[]; examples?: Array<Record<string, unknown>> } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("Provide workflow for action=workflow_help.");
  const spec = PROXMOX_WORKFLOW_CAPABILITIES[raw];
  if (!spec) throw new Error(`Unknown Proxmox workflow: ${raw}`);
  const recommendedFor = uniqueStrings([...(spec.recommended_for || []), ...getProxmoxDefaultRecommendedFor(spec.category)]);
  const seeAlso = uniqueStrings([...(spec.see_also || []), ...getProxmoxDefaultSeeAlso(raw, spec.category)]).filter((entry) => entry !== raw).slice(0, 5);
  const guidance = getProxmoxDefaultGuidance(raw, spec);
  return {
    canonical_workflow: raw,
    runtime_workflow: resolveRuntimeProxmoxWorkflowName(raw),
    spec,
    recommended_for: recommendedFor,
    see_also: seeAlso,
    guidance,
    ...(options?.include_examples ? { examples: buildProxmoxWorkflowExamples(raw, spec) } : {}),
  };
}

function tokenizeIntent(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).map((entry) => entry.trim()).filter((entry) => entry.length >= 2);
}

function scoreProxmoxWorkflowForIntent(workflow: string, spec: WorkflowCapabilitySpec, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const haystacks = [workflow, spec.category, spec.summary, ...(spec.recommended_for || []), ...(spec.guidance || []), ...(spec.see_also || [])]
    .join(" ")
    .toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (workflow.toLowerCase().includes(token)) score += 5;
    if (spec.category.toLowerCase().includes(token)) score += 3;
    if (haystacks.includes(token)) score += 2;
  }
  if (tokens.some((token) => ["restore", "recover", "backup"].includes(token)) && workflow === "backup.restore") score += 8;
  if (tokens.some((token) => ["log", "logs", "syslog"].includes(token)) && workflow === "node.log") score += 8;
  if (tokens.some((token) => ["reboot", "restart", "maintenance"].includes(token)) && workflow === "node.reboot") score += 8;
  if (tokens.some((token) => ["shutdown", "poweroff", "halt"].includes(token)) && workflow === "node.shutdown") score += 8;
  if (tokens.some((token) => ["migrate", "move"].includes(token)) && workflow === "vm.migrate") score += 6;
  if (tokens.some((token) => ["create", "provision", "new"].includes(token)) && workflow === "vm.create") score += 8;
  if (tokens.some((token) => ["create", "provision", "new"].includes(token)) && workflow === "lxc.create") score += 8;
  if (tokens.some((token) => ["storage", "datastore"].includes(token)) && workflow === "storage.create") score += 8;
  if (tokens.some((token) => ["iso", "download", "media"].includes(token)) && workflow === "storage.download_url") score += 8;
  if (tokens.some((token) => ["iso", "attach", "mount"].includes(token)) && workflow === "vm.iso.attach") score += 8;
  if (tokens.some((token) => ["iso", "detach", "eject"].includes(token)) && workflow === "vm.iso.detach") score += 8;
  if (tokens.some((token) => ["resize", "grow"].includes(token)) && workflow === "vm.disk.resize") score += 8;
  if (tokens.some((token) => ["remove", "delete"].includes(token)) && workflow === "vm.disk.remove") score += 8;
  return score;
}

function buildProxmoxRecommendations(intent: string | undefined, options?: { category?: string; max_recommendations?: number }): Record<string, unknown> {
  const rawIntent = typeof intent === "string" ? intent.trim() : "";
  if (!rawIntent) throw new Error("Provide intent for action=recommend.");
  const category = normalizeCategoryFilter(options?.category);
  const tokens = tokenizeIntent(rawIntent);
  const entries = getProxmoxWorkflowEntries(category)
    .map((entry) => {
      const help = getProxmoxWorkflowHelp(entry.name);
      return {
        workflow: entry.name,
        category: entry.category,
        summary: entry.summary,
        score: scoreProxmoxWorkflowForIntent(entry.name, entry, tokens),
        required_fields: entry.required_fields,
        recommended_for: help.recommended_for,
        guidance: help.guidance.slice(0, 2),
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.workflow.localeCompare(b.workflow));
  const maxRecommendations = Math.min(Math.max(Math.trunc(options?.max_recommendations ?? 3), 1), 10);
  const recommendations = entries.slice(0, maxRecommendations);
  return {
    intent: rawIntent,
    ...(category ? { category } : {}),
    token_count: tokens.length,
    recommendation_count: recommendations.length,
    recommendations,
    next_steps: recommendations.length > 0
      ? [
        "Use workflow_help for the top workflow to fetch required fields and guidance.",
        "Set include_examples=true on workflow_help only if you need an example payload.",
      ]
      : [
        "Try a broader category or a more specific intent phrase.",
        "Use capabilities to inspect available families if the intent is still ambiguous.",
      ],
  };
}

const PROXMOX_TOOL_HINT = [
  "## Proxmox",
  "Use proxmox to inspect or change the Proxmox API profile for the current session.",
  "The addon settings pane can provide default host/IP, username, token keychain, and TLS settings for all chats.",
  "Use proxmox discover to find a likely existing Proxmox instance from addon settings, keychain hints, or env hints.",
  "Use proxmox capabilities to list workflow families, proxmox recommend for intent-based shortlists, and proxmox workflow_help for one workflow's fields/guidance.",
  "Use proxmox contract for the overall tool contract and request_help for raw request fields, response shape, and charting-oriented request examples.",
  "Use proxmox request for ad-hoc API calls and proxmox workflow for reusable VM/LXC/node/storage/backup/task/metrics orchestration.",
  "Keep the raw request path available so future metrics/charting and other Proxmox API surfaces do not need bespoke runtime primitives.",
].join("\n");

function normalizeChatJid(value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || getChatJid("web:default");
}

function buildWorkflowSummary(workflow: string, result: ProxmoxWorkflowResponse): string {
  const vmPrefix = result.vmid ? ` VM ${result.vmid}` : "";
  const nodeSuffix = result.node ? ` on ${result.node}` : "";
  const maybePoints = typeof (result.result as { points?: unknown[] } | null)?.points?.length === "number"
    ? ` (${((result.result as { points?: unknown[] }).points || []).length} points)`
    : "";
  return `Proxmox workflow ${workflow}${vmPrefix}${nodeSuffix} completed${maybePoints}.`;
}

function startProxmoxUiProgress(ctx: { hasUI?: boolean; ui?: { setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void; setWorkingMessage: (message?: string) => void } }, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingIndicator({ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 90 });
  ctx.ui.setWorkingMessage(message);
}

function finishProxmoxUiProgress(ctx: { hasUI?: boolean; ui?: { setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void; setWorkingMessage: (message?: string) => void } }): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(undefined);
  ctx.ui.setWorkingIndicator({ frames: [] });
}

/** Registers the agent-only Proxmox API configuration/request tool. */
export const proxmoxTool: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${PROXMOX_TOOL_HINT}`,
  }));

  // @ts-expect-error TS2589 — Typebox Union schema depth exceeds TS limit in strict mode
  pi.registerTool({
    name: "proxmox",
    label: "proxmox",
    description: "Get, set, or clear the session-scoped Proxmox API profile, perform ad-hoc API requests, or run common Proxmox workflows.",
    promptSnippet: "proxmox: inspect/update the current session Proxmox API profile, send ad-hoc API requests, or run common VM/task/metrics workflows.",
    parameters: ProxmoxToolSchema,
    async execute(_toolCallId, params, _signal, _update, ctx): Promise<ProxmoxToolResult> {
      const chatJid = normalizeChatJid(params.chat_jid);

      if (params.action === "contract") {
        const payload = buildProxmoxContractPayload();
        return {
          content: [{
            type: "text",
            text: "Proxmox contract: discover → capabilities/recommend → workflow_help → workflow/request. Use request_help for raw request examples and response-shape guidance.",
          }],
          details: { action: "contract", chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "capabilities") {
        const payload = buildProxmoxCapabilitiesPayload({
          category: params.category,
          include_workflows: params.include_workflows,
        });
        const familyCount = Array.isArray(payload.workflow_families) ? payload.workflow_families.length : 0;
        const filteredCount = typeof payload.matching_workflow_count === "number" ? payload.matching_workflow_count : null;
        return {
          content: [{
            type: "text",
            text: typeof payload.category === "string"
              ? `Proxmox family ${payload.category} exposes ${filteredCount ?? 0} workflows. Use workflow_help for one workflow and include_examples=true only when needed.`
              : `Proxmox supports ${String(payload.workflow_count)} documented workflows across ${familyCount} families. Use category to drill into one family without pulling the whole surface.`,
          }],
          details: { action: "capabilities", chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "workflow_help") {
        const help = getProxmoxWorkflowHelp(params.workflow, { include_examples: params.include_examples === true });
        return {
          content: [{ type: "text", text: `Proxmox workflow ${help.canonical_workflow}: ${help.spec.summary}` }],
          details: {
            action: "workflow_help",
            chat_jid: chatJid,
            canonical_workflow: help.canonical_workflow,
            runtime_workflow: help.runtime_workflow,
            ...help.spec,
            recommended_for: help.recommended_for,
            see_also: help.see_also,
            guidance: help.guidance,
            ...(help.examples ? { examples: help.examples } : {}),
          },
        };
      }

      if (params.action === "request_help") {
        const payload = buildProxmoxRequestHelpPayload();
        return {
          content: [{
            type: "text",
            text: "Proxmox request help: provide path for one request or requests for a sequential batch; method defaults to GET; use details.request_contract for examples and response-shape guidance.",
          }],
          details: { chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "recommend") {
        const payload = buildProxmoxRecommendations(params.intent, {
          category: params.category,
          max_recommendations: params.max_recommendations,
        });
        const recommendationCount = typeof payload.recommendation_count === "number" ? payload.recommendation_count : 0;
        const intent = typeof payload.intent === "string" ? payload.intent : "";
        return {
          content: [{
            type: "text",
            text: recommendationCount
              ? `Proxmox found ${String(recommendationCount)} workflow recommendation(s) for \"${intent}\".`
              : `Proxmox found no strong workflow matches for \"${intent}\".`,
          }],
          details: { action: "recommend", chat_jid: chatJid, ...payload },
        };
      }

      const handlers = registeredHandlers;
      if (params.action === "get") {
        const resolved = resolveProxmoxConfigState(chatJid, handlers?.get(chatJid));
        if (!resolved.effective_config) {
          return {
            content: [{ type: "text", text: `No usable Proxmox config stored for ${chatJid}. Fill in the Proxmox addon settings or use action=set.` }],
            details: {
              action: "get",
              chat_jid: chatJid,
              configured: false,
              source: resolved.source,
              config: null,
              stored_config: resolved.stored_config,
              settings_config: resolved.settings_config,
            },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Proxmox config for ${chatJid}: ${resolved.effective_config.base_url} as ${resolved.effective_config.username} (key ${resolved.effective_config.api_token_keychain}, source ${resolved.source}, insecure TLS ${resolved.effective_config.allow_insecure_tls ? "on" : "off"}).`,
          }],
          details: {
            action: "get",
            chat_jid: chatJid,
            configured: true,
            source: resolved.source,
            config: resolved.effective_config,
            stored_config: resolved.stored_config,
            settings_config: resolved.settings_config,
          },
        };
      }

      if (params.action === "set") {
        const current = handlers?.get(chatJid) ?? kvGetConfig(chatJid);
        const result = handlers
          ? await handlers.set(chatJid, {
              base_url: typeof params.base_url === "string" ? params.base_url.trim() : (current?.base_url || ""),
              username: typeof params.username === "string" ? params.username.trim() : (current?.username || ""),
              api_token_keychain: typeof params.api_token_keychain === "string" ? params.api_token_keychain.trim() : (current?.api_token_keychain || ""),
              allow_insecure_tls: params.allow_insecure_tls ?? current?.allow_insecure_tls ?? true,
            })
          : kvSetConfig(chatJid, {
              base_url: typeof params.base_url === "string" ? params.base_url.trim() : (current?.base_url || ""),
              username: typeof params.username === "string" ? params.username.trim() : (current?.username || ""),
              api_token_keychain: typeof params.api_token_keychain === "string" ? params.api_token_keychain.trim() : (current?.api_token_keychain || ""),
              allow_insecure_tls: params.allow_insecure_tls ?? current?.allow_insecure_tls ?? true,
            });
        const resolved = resolveProxmoxConfigState(chatJid, result.config);
        return {
          content: [{
            type: "text",
            text: `Stored Proxmox session override for ${chatJid}: ${resolved.effective_config?.base_url || result.config.base_url || "(inherits addon settings)"} as ${resolved.effective_config?.username || result.config.username || "(inherits addon settings)"}. Applies immediately.`,
          }],
          details: {
            action: "set",
            chat_jid: chatJid,
            updated: true,
            apply_timing: result.apply_timing,
            config: result.config,
            effective_config: resolved.effective_config,
            source: resolved.source,
          },
        };
      }

      if (params.action === "clear") {
        const result = handlers ? await handlers.clear(chatJid) : kvClearConfig(chatJid);
        const resolved = resolveProxmoxConfigState(chatJid, null);
        return {
          content: [{
            type: "text",
            text: result.deleted
              ? (resolved.effective_config
                ? `Cleared Proxmox session override for ${chatJid}. Addon settings remain available.`
                : `Cleared Proxmox config for ${chatJid}. Applies immediately.`)
              : `No Proxmox config existed for ${chatJid}. Applies immediately.`,
          }],
          details: {
            action: "clear",
            chat_jid: chatJid,
            deleted: result.deleted,
            apply_timing: result.apply_timing,
            effective_config: resolved.effective_config,
            source: resolved.source,
          },
        };
      }

      if (params.action === "discover") {
        startProxmoxUiProgress(ctx, "Proxmox: discovering configured instances…");
        try {
          const settings = loadProxmoxSettingsConfig();
          const discovery = await discoverProxmoxInstances(settings);
          return {
            content: [{
              type: "text",
              text: discovery.default_candidate
                ? `Discovered ${discovery.candidates.length} Proxmox candidate(s); default ${discovery.default_candidate.api_token_keychain}${discovery.default_candidate.base_url ? ` @ ${discovery.default_candidate.base_url}` : ""}.`
                : "No Proxmox instances discovered from addon settings, keychain hints, or env hints.",
            }],
            details: {
              action: "discover",
              chat_jid: chatJid,
              settings_config: settings,
              ...discovery,
            },
          };
        } finally {
          finishProxmoxUiProgress(ctx);
        }
      }

      if (params.action === "workflow") {
        if (!params.workflow) {
          return {
            content: [{ type: "text", text: "Provide workflow for action=workflow." }],
            details: { action: "workflow", chat_jid: chatJid, ok: false },
          };
        }

        const help = getProxmoxWorkflowHelp(params.workflow);
        startProxmoxUiProgress(ctx, `Proxmox: running workflow ${help.canonical_workflow}…`);
        try {
          const workflowResult = await (handlers?.workflow ?? kvWorkflow)(chatJid, {
          workflow: help.runtime_workflow,
          ...(typeof params.vmid === "number" ? { vmid: params.vmid } : {}),
          ...(typeof params.node === "string" ? { node: params.node } : {}),
          ...(typeof params.storage === "string" ? { storage: params.storage } : {}),
          ...(typeof params.upid === "string" ? { upid: params.upid } : {}),
          ...(typeof params.backup_volid === "string" ? { backup_volid: params.backup_volid } : {}),
          ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
          ...(typeof params.poll_ms === "number" ? { poll_ms: params.poll_ms } : {}),
          ...(typeof params.force === "boolean" ? { force: params.force } : {}),
          ...(params.target ? { target: params.target } : {}),
          ...(typeof params.timeframe === "string" ? { timeframe: params.timeframe } : {}),
          ...(typeof params.cf === "string" ? { cf: params.cf } : {}),
          ...(typeof params.metric === "string" ? { metric: params.metric } : {}),
          ...(Array.isArray(params.metrics) ? { metrics: params.metrics } : {}),
          ...(typeof params.snapshot_name === "string" ? { snapshot_name: params.snapshot_name } : {}),
          ...(typeof params.description === "string" ? { description: params.description } : {}),
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          ...(typeof params.hostname === "string" ? { hostname: params.hostname } : {}),
          ...(typeof params.memory === "number" ? { memory: params.memory } : {}),
          ...(typeof params.cores === "number" ? { cores: params.cores } : {}),
          ...(typeof params.sockets === "number" ? { sockets: params.sockets } : {}),
          ...(typeof params.ostype === "string" ? { ostype: params.ostype } : {}),
          ...(typeof params.net0 === "string" ? { net0: params.net0 } : {}),
          ...(typeof params.ostemplate === "string" ? { ostemplate: params.ostemplate } : {}),
          ...(typeof params.rootfs === "string" ? { rootfs: params.rootfs } : {}),
          ...(typeof params.password === "string" ? { password: params.password } : {}),
          ...(typeof params.ssh_public_keys === "string" ? { ssh_public_keys: params.ssh_public_keys } : {}),
          ...(typeof params.unprivileged === "boolean" ? { unprivileged: params.unprivileged } : {}),
          ...(params.config && typeof params.config === "object" && !Array.isArray(params.config) ? { config: params.config as Record<string, unknown> } : {}),
          ...(typeof params.newid === "number" ? { newid: params.newid } : {}),
          ...(typeof params.new_name === "string" ? { new_name: params.new_name } : {}),
          ...(typeof params.target_node === "string" ? { target_node: params.target_node } : {}),
          ...(typeof params.target_storage === "string" ? { target_storage: params.target_storage } : {}),
          ...(typeof params.storage_type === "string" ? { storage_type: params.storage_type } : {}),
          ...(typeof params.full === "boolean" ? { full: params.full } : {}),
          ...(typeof params.online === "boolean" ? { online: params.online } : {}),
          ...(typeof params.with_local_disks === "boolean" ? { with_local_disks: params.with_local_disks } : {}),
          ...(typeof params.mode === "string" ? { mode: params.mode } : {}),
          ...(typeof params.compress === "string" ? { compress: params.compress } : {}),
          ...(typeof params.slot === "string" ? { slot: params.slot } : {}),
          ...(typeof params.iso_volume === "string" ? { iso_volume: params.iso_volume } : {}),
          ...(typeof params.disk === "string" ? { disk: params.disk } : {}),
          ...(typeof params.size === "string" ? { size: params.size } : {}),
          ...(typeof params.unlink === "boolean" ? { unlink: params.unlink } : {}),
          ...(typeof params.download_url === "string" ? { download_url: params.download_url } : {}),
          ...(typeof params.filename === "string" ? { filename: params.filename } : {}),
          ...(typeof params.content === "string" ? { content: params.content } : {}),
          ...(typeof params.checksum === "string" ? { checksum: params.checksum } : {}),
          ...(typeof params.checksum_algorithm === "string" ? { checksum_algorithm: params.checksum_algorithm } : {}),
          ...(typeof params.compression === "string" ? { compression: params.compression } : {}),
          ...(typeof params.verify_certificates === "boolean" ? { verify_certificates: params.verify_certificates } : {}),
          ...(typeof params.command === "string" ? { command: params.command } : {}),
          ...(Array.isArray(params.command_args) ? { command_args: params.command_args } : {}),
          ...(typeof params.input_data === "string" ? { input_data: params.input_data } : {}),
          ...(params.shell_family === "powershell" || params.shell_family === "posix" ? { shell_family: params.shell_family } : {}),
          ...(typeof params.limit === "number" ? { limit: params.limit } : {}),
          ...(typeof params.lines === "number" ? { lines: params.lines } : {}),
        });

        const presented = presentStructuredToolValue(
          buildWorkflowSummary(help.canonical_workflow, workflowResult),
          "Result",
          workflowResult.result,
          `proxmox:workflow:${help.canonical_workflow}`,
        );

          return {
            content: [{
              type: "text",
              text: presented.text,
            }],
            details: {
              action: "workflow",
              chat_jid: chatJid,
              ok: true,
              canonical_workflow: help.canonical_workflow,
              runtime_workflow: help.runtime_workflow,
              response: workflowResult,
              ...(presented.stored_output ? { result_tool_output: presented.stored_output } : {}),
            },
          };
        } finally {
          finishProxmoxUiProgress(ctx);
        }
      }

      const outputPath = typeof params.output_path === "string" ? params.output_path.trim() : "";
      const outputFormat = params.output_format === "jsonl" ? "jsonl" : "json";
      const requestBatch = Array.isArray(params.requests) ? params.requests : [];
      if (requestBatch.length > 0) {
        const batchRequests = requestBatch.map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`Proxmox batch request entry ${index + 1} must be an object.`);
          }
          const item = entry as Record<string, unknown>;
          const batchPath = typeof item.path === "string" ? item.path.trim() : "";
          if (!batchPath) {
            throw new Error(`Proxmox batch request entry ${index + 1} requires path.`);
          }
          const batchBodyMode = item.body_mode === "form" || item.body_mode === "json"
            ? item.body_mode
            : undefined;
          return {
            ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
            method: typeof item.method === "string" && item.method.trim() ? item.method.trim().toUpperCase() : "GET",
            path: batchPath,
            ...(item.query !== undefined ? { query: item.query } : {}),
            ...(item.body !== undefined ? { body: item.body } : {}),
            ...(batchBodyMode ? { body_mode: batchBodyMode as "form" | "json" } : {}),
          };
        });

        const batch = await runRequestBatch({
          requests: batchRequests,
          execute: (request) => (handlers?.request ?? kvRequest)(chatJid, request),
          timeout_ms: params.timeout_ms,
          retries: params.retries,
          retry_delay_ms: params.retry_delay_ms,
          retry_backoff_factor: params.retry_backoff_factor,
          throttle_ms: params.throttle_ms,
          pause_ms: params.pause_ms,
          fail_fast: params.fail_fast,
          timeout_label_prefix: "Proxmox batch",
          getLabel: (request) => request.label || `${request.method} ${request.path}`,
        });

        const presented = presentStructuredToolValue(
          `Proxmox request batch ${batch.ok ? "completed" : "completed with failures"}: ${batch.success_count} succeeded, ${batch.failure_count} failed across ${batch.request_count} request(s).${batch.stopped_early ? " Stopped early due to fail_fast." : ""}`,
          "Batch result",
          batch,
          "proxmox:request:batch",
        );
        const outputFile = outputPath ? writeRequestOutputFile(outputPath, outputFormat, batch) : undefined;

        return {
          content: [{
            type: "text",
            text: appendOutputFileNote(presented.text, outputFile),
          }],
          details: {
            action: "request",
            chat_jid: chatJid,
            ok: batch.ok,
            batch,
            ...(presented.stored_output ? { batch_tool_output: presented.stored_output } : {}),
            ...(outputFile ? { output_file: outputFile } : {}),
          },
        };
      }

      const path = typeof params.path === "string" ? params.path.trim() : "";
      const method = typeof params.method === "string" && params.method.trim() ? params.method.trim().toUpperCase() : "GET";
      if (!path) {
        return {
          content: [{ type: "text", text: "Provide path or requests for action=request." }],
          details: { action: "request", chat_jid: chatJid, ok: false },
        };
      }

      const response = await (handlers?.request ?? kvRequest)(chatJid, {
        method,
        path,
        ...(params.query !== undefined ? { query: params.query } : {}),
        ...(params.body !== undefined ? { body: params.body } : {}),
        ...(params.body_mode ? { body_mode: params.body_mode } : {}),
        ...(typeof params.timeout_ms === "number" ? { timeout_ms: params.timeout_ms } : {}),
      });

      const presented = presentStructuredToolValue(
        `Proxmox ${response.method} ${response.path} succeeded with HTTP ${response.status}.`,
        "Response",
        response.body,
        `proxmox:request:${response.method}:${response.path}`,
      );
      const outputFile = outputPath ? writeRequestOutputFile(outputPath, outputFormat, response) : undefined;

      return {
        content: [{
          type: "text",
          text: appendOutputFileNote(presented.text, outputFile),
        }],
        details: {
          action: "request",
          chat_jid: chatJid,
          ok: true,
          response,
          ...(presented.stored_output ? { response_tool_output: presented.stored_output } : {}),
          ...(outputFile ? { output_file: outputFile } : {}),
        },
      };
    },
  });
};
