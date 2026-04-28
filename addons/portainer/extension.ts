import type { ExtensionAPI, ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { getChatJid } from "./compat/chat-context.js";
import { registerToolStatusHintProvider } from "./compat/tool-status-hints.js";
import { createExtensionStorage, type ExtensionStorage } from "./compat/extension-kv.js";
import type {
  PortainerConfig,
  PortainerConfigClearResult,
  PortainerConfigSetResult,
} from "./compat/types.js";
import {
  discoverPortainerInstances,
  requestPortainerApi,
  runPortainerWorkflow,
  type PortainerApiConfig,
  type PortainerApiMethod,
  type PortainerWorkflowRequest,
  type PortainerWorkflowResponse,
  type PortainerWorkflowName,
} from "./client.js";
import {
  appendOutputFileNote,
  runRequestBatch,
  writeRequestOutputFile,
} from "./compat/request-batch.js";
import { presentStructuredToolValue } from "./compat/structured-tool-response.js";

type SessionPortainerConfigInput = Omit<PortainerConfig, "chat_jid" | "created_at" | "updated_at">;
type PortainerToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

export interface PortainerRequestResult {
  status: number;
  method: string;
  path: string;
  body: unknown;
}

export interface PortainerToolHandlers {
  get(chatJid: string): PortainerConfig | null;
  set(chatJid: string, config: SessionPortainerConfigInput): Promise<PortainerConfigSetResult>;
  clear(chatJid: string): Promise<PortainerConfigClearResult>;
  request(
    chatJid: string,
    input: {
      method: string;
      path: string;
      query?: unknown;
      body?: unknown;
      body_mode?: "json" | "text";
      headers?: Record<string, string>;
    },
  ): Promise<PortainerRequestResult>;
  workflow(chatJid: string, input: PortainerWorkflowRequest): Promise<PortainerWorkflowResponse>;
}

let registeredHandlers: PortainerToolHandlers | null = null;
let kvStorage: ExtensionStorage | null = null;

function getStorage(): ExtensionStorage {
  if (!kvStorage) kvStorage = createExtensionStorage("portainer");
  return kvStorage;
}

function kvGetConfig(chatJid: string): PortainerConfig | null {
  return getStorage().get<PortainerConfig>("config", "chat", chatJid);
}

function kvSetConfig(chatJid: string, config: SessionPortainerConfigInput): PortainerConfigSetResult {
  const full: PortainerConfig = {
    chat_jid: chatJid,
    base_url: config.base_url,
    api_token_keychain: config.api_token_keychain,
    allow_insecure_tls: config.allow_insecure_tls,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  getStorage().set("config", full, "chat", chatJid);
  return { config: full, apply_timing: "immediate" };
}

function kvClearConfig(chatJid: string): PortainerConfigClearResult {
  const deleted = getStorage().delete("config", "chat", chatJid);
  return { deleted, apply_timing: "immediate" };
}

function resolveApiConfig(chatJid: string): PortainerApiConfig | null {
  const config = kvGetConfig(chatJid);
  if (!config) return null;
  return {
    base_url: config.base_url,
    api_token_keychain: config.api_token_keychain,
    allow_insecure_tls: config.allow_insecure_tls ?? true,
  };
}

async function kvRequest(chatJid: string, input: { method: string; path: string; query?: unknown; body?: unknown; body_mode?: string }): Promise<PortainerRequestResult> {
  const apiConfig = resolveApiConfig(chatJid);
  if (!apiConfig) throw new Error(`No Portainer config for ${chatJid}. Use action=set first.`);
  const response = await requestPortainerApi(apiConfig, {
    method: input.method as PortainerApiMethod,
    path: input.path,
    query: input.query,
    body: input.body,
  });
  return { status: response.status, method: input.method, path: input.path, body: response.body };
}

async function kvWorkflow(chatJid: string, input: PortainerWorkflowRequest): Promise<PortainerWorkflowResponse> {
  const apiConfig = resolveApiConfig(chatJid);
  if (!apiConfig) throw new Error(`No Portainer config for ${chatJid}. Use action=set first.`);
  return runPortainerWorkflow(apiConfig, input);
}

const PORTAINER_STATUS_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="7" width="7" height="5.5" rx="1"></rect><rect x="13.5" y="7" width="7" height="5.5" rx="1"></rect><rect x="8.5" y="13.5" width="7" height="5.5" rx="1"></rect><path d="M12 13.5v-1.5"></path></svg>`;

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

export function setPortainerToolHandlers(handlers: PortainerToolHandlers | null | undefined): void {
  registeredHandlers = handlers ?? null;
}

registerToolStatusHintProvider({
  id: "portainer",
  buildHints: ({ chatJid, toolName, args }) => {
    if (toolName !== "portainer") return null;
    const record = args && typeof args === "object" ? args as Record<string, unknown> : null;
    const host = extractHostLabelFromUrl(
      readTrimmedString(
        record?.base_url,
        record?.baseUrl,
        record?.url,
        record?.endpoint,
        registeredHandlers?.get(chatJid)?.base_url ?? kvGetConfig(chatJid)?.base_url,
      ),
    );
    if (!host) return null;
    return {
      key: "portainer",
      icon_svg: PORTAINER_STATUS_ICON_SVG,
      label: host,
      title: "Portainer host",
      kind: "service",
    };
  },
});

const PortainerWorkflowSchema = Type.Union([
  Type.Literal("endpoint.list"),
  Type.Literal("endpoint.resolve"),
  Type.Literal("endpoint.inspect"),
  Type.Literal("endpoint.ping"),
  Type.Literal("endpoint.docker_info"),
  Type.Literal("endpoint.docker_version"),
  Type.Literal("endpoint.system_df"),
  Type.Literal("stack.list"),
  Type.Literal("stack.resolve"),
  Type.Literal("stack.file"),
  Type.Literal("stack.create_standalone"),
  Type.Literal("stack.update"),
  Type.Literal("stack.pull_and_update"),
  Type.Literal("stack.delete"),
  Type.Literal("container.list"),
  Type.Literal("container.resolve"),
  Type.Literal("container.inspect"),
  Type.Literal("container.compose"),
  Type.Literal("container.start"),
  Type.Literal("container.stop"),
  Type.Literal("container.restart"),
  Type.Literal("container.logs"),
  Type.Literal("container.mounts"),
  Type.Literal("container.exec"),
  Type.Literal("container.upgrade"),
  Type.Literal("container.upgrade_many"),
  Type.Literal("container.delete"),
  Type.Literal("image.list"),
  Type.Literal("image.inspect"),
  Type.Literal("image.pull"),
  Type.Literal("image.delete"),
  Type.Literal("image.prune"),
  Type.Literal("image.update_check"),
  Type.Literal("network.list"),
  Type.Literal("network.inspect"),
  Type.Literal("network.create"),
  Type.Literal("network.delete"),
  Type.Literal("volume.list"),
  Type.Literal("volume.inspect"),
  Type.Literal("volume.create"),
  Type.Literal("volume.delete"),
  Type.Literal("volume.prune"),
], { description: "Named higher-level Portainer workflow to run." });

const PortainerRawRequestItemSchema = Type.Object({
  label: Type.Optional(Type.String({ description: "Optional label for one request in a batch." })),
  method: Type.Optional(Type.String({ description: "HTTP method for this batched request (defaults to GET)." })),
  path: Type.String({ description: "Relative Portainer API path for this batched request." }),
  query: Type.Optional(Type.Any({ description: "Optional query-string parameters for this batched request." })),
  body: Type.Optional(Type.Any({ description: "Optional request body for this batched request." })),
  body_mode: Type.Optional(Type.Union([
    Type.Literal("json"),
    Type.Literal("text"),
  ], { description: "How to encode the request body for this batched request." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional extra headers for this batched request." })),
});

const PortainerToolSchema = Type.Object({
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
    description: "Operation to perform for the current chat Portainer config, API request, or workflow.",
  }),
  chat_jid: Type.Optional(Type.String({ description: "Target chat JID. Defaults to the current chat context." })),
  base_url: Type.Optional(Type.String({ description: "Portainer base URL, typically like https://host:9443." })),
  api_token_keychain: Type.Optional(Type.String({ description: "Keychain entry containing the Portainer API token secret." })),
  allow_insecure_tls: Type.Optional(Type.Boolean({ description: "Allow insecure/self-signed TLS when calling the API." })),
  method: Type.Optional(Type.String({ description: "HTTP method for action=request (GET, POST, PUT, DELETE)." })),
  path: Type.Optional(Type.String({ description: "Relative Portainer API path for action=request." })),
  query: Type.Optional(Type.Any({ description: "Optional query-string parameters for action=request." })),
  body: Type.Optional(Type.Any({ description: "Optional request body for action=request." })),
  body_mode: Type.Optional(Type.Union([
    Type.Literal("json"),
    Type.Literal("text"),
  ], { description: "How to encode the request body for action=request." })),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional extra headers for action=request." })),
  requests: Type.Optional(Type.Array(PortainerRawRequestItemSchema, { description: "Optional sequential batch of raw Portainer requests for action=request. When provided, path/method/body/query apply per item instead of globally." })),
  pause_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Fixed pause between sequential batched requests." })),
  throttle_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Minimum spacing between the start of batched request attempts, including retries." })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1, description: "Per-request timeout for batched raw requests." })),
  retries: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Retry count for batched raw requests on retriable failures." })),
  retry_delay_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Initial delay before retrying a failed batched request." })),
  retry_backoff_factor: Type.Optional(Type.Number({ minimum: 1, description: "Backoff multiplier applied to retry_delay_ms for each additional retry." })),
  fail_fast: Type.Optional(Type.Boolean({ description: "Stop a batched request sequence after the first non-retriable or exhausted failure. Defaults to true." })),
  output_path: Type.Optional(Type.String({ description: "Optional workspace-relative output file path for action=request results." })),
  output_format: Type.Optional(Type.Union([
    Type.Literal("json"),
    Type.Literal("jsonl"),
  ], { description: "Optional output file format for action=request results (default json)." })),
  workflow: Type.Optional(PortainerWorkflowSchema),
  category: Type.Optional(Type.String({ description: "Optional workflow family/category filter for action=capabilities or action=recommend." })),
  include_workflows: Type.Optional(Type.Boolean({ description: "Include detailed workflow entries for action=capabilities. Defaults to false unless category is set." })),
  include_examples: Type.Optional(Type.Boolean({ description: "Include generated example payloads for action=workflow_help." })),
  intent: Type.Optional(Type.String({ description: "Short goal description for action=recommend, e.g. 'update a standalone container' or 'find stack compose'." })),
  max_recommendations: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum workflow recommendations for action=recommend (default 3)." })),
  endpoint_id: Type.Optional(Type.Integer({ minimum: 1, description: "Endpoint ID for endpoint/stack/container workflows." })),
  stack_id: Type.Optional(Type.Integer({ minimum: 1, description: "Stack ID for stack workflows." })),
  container_id: Type.Optional(Type.String({ description: "Container ID/prefix for container workflows." })),
  network_id: Type.Optional(Type.String({ description: "Network ID/prefix for network workflows." })),
  name: Type.Optional(Type.String({ description: "Generic lookup name for endpoint/container/network workflows, or a fallback image/volume name where applicable." })),
  image: Type.Optional(Type.String({ description: "Image reference for image workflows." })),
  volume_name: Type.Optional(Type.String({ description: "Volume name for volume.inspect." })),
  stack_name: Type.Optional(Type.String({ description: "Stack name for create workflows." })),
  stack_file_content: Type.Optional(Type.String({ description: "Compose content for stack create/update workflows." })),
  unmanaged: Type.Optional(Type.Boolean({ description: "Only keep unmanaged containers for container.list." })),
  force: Type.Optional(Type.Boolean({ description: "Force deletion for container.delete, container.upgrade cleanup, or image.delete." })),
  all_unused: Type.Optional(Type.Boolean({ description: "Prune all unused images for image.prune, not just dangling ones." })),
  tail: Type.Optional(Type.Integer({ minimum: 1, description: "Tail line count for container.logs." })),
  timestamps: Type.Optional(Type.Boolean({ description: "Include timestamps for container.logs." })),
  timeout_sec: Type.Optional(Type.Integer({ minimum: 1, description: "Stop/restart timeout seconds for container workflows." })),
  command: Type.Optional(Type.String({ description: "Command for bounded container.exec workflows." })),
  command_args: Type.Optional(Type.Array(Type.String(), { description: "Command arguments for bounded container.exec workflows." })),
  shell_family: Type.Optional(Type.Union([
    Type.Literal("posix"),
    Type.Literal("powershell"),
  ], { description: "Shell wrapper family for exec-style workflows like container.exec." })),
  driver: Type.Optional(Type.String({ description: "Network driver for network.create." })),
  internal: Type.Optional(Type.Boolean({ description: "Whether network.create should create an internal network." })),
  attachable: Type.Optional(Type.Boolean({ description: "Whether network.create should create an attachable network." })),
  enable_ipv6: Type.Optional(Type.Boolean({ description: "Whether network.create should enable IPv6." })),
  labels: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional labels for network.create." })),
  options: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional driver options for network.create or volume.create." })),
  names: Type.Optional(Type.Array(Type.String(), { description: "Container names for bulk workflows like container.upgrade_many." })),
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

const PORTAINER_WORKFLOW_FAMILY_SUMMARIES: Record<string, string> = {
  container: "Container lifecycle, logs, exec, and standalone upgrade workflows.",
  endpoint: "Endpoint discovery and Docker host inspection workflows.",
  image: "Image inventory, pull, cleanup, and update-planning workflows.",
  network: "Docker network inventory and lifecycle workflows.",
  stack: "Stack lookup, file, create, update, and pull-update workflows.",
  volume: "Docker volume inventory and lifecycle workflows.",
};

const PORTAINER_WORKFLOW_CAPABILITIES: Record<string, WorkflowCapabilitySpec> = {
  "endpoint.list": { category: "endpoint", summary: "List Portainer endpoints.", required_fields: [] },
  "endpoint.resolve": { category: "endpoint", summary: "Resolve an endpoint by ID or name.", required_fields: [], optional_fields: ["endpoint_id", "name"], recommended_for: ["finding an endpoint ID before inspect or mutate flows"] },
  "endpoint.inspect": { category: "endpoint", summary: "Inspect one endpoint.", required_fields: ["endpoint_id"] },
  "endpoint.ping": { category: "endpoint", summary: "Ping a Docker endpoint.", required_fields: ["endpoint_id"] },
  "endpoint.docker_info": { category: "endpoint", summary: "Read Docker daemon info.", required_fields: ["endpoint_id"] },
  "endpoint.docker_version": { category: "endpoint", summary: "Read Docker version info.", required_fields: ["endpoint_id"] },
  "endpoint.system_df": { category: "endpoint", summary: "Read Docker disk-usage summary.", required_fields: ["endpoint_id"], recommended_for: ["checking host storage pressure before cleanup or upgrades"] },
  "stack.list": { category: "stack", summary: "List stacks, optionally for one endpoint.", required_fields: [], optional_fields: ["endpoint_id"] },
  "stack.resolve": { category: "stack", summary: "Resolve a stack by ID or name.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"], recommended_for: ["finding a stack ID before file, update, or delete work"] },
  "stack.file": { category: "stack", summary: "Read stack compose content.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"] },
  "stack.create_standalone": { category: "stack", summary: "Create a standalone stack from compose content.", required_fields: ["endpoint_id", "stack_name", "stack_file_content"], mutating: true },
  "stack.update": { category: "stack", summary: "Update a stack with supplied compose content.", required_fields: ["endpoint_id", "stack_id", "stack_file_content"], mutating: true },
  "stack.pull_and_update": { category: "stack", summary: "Resolve a stack, re-read its compose, and update with pull enabled.", required_fields: [], optional_fields: ["endpoint_id", "stack_id", "stack_name", "name"], mutating: true, recommended_for: ["refreshing stack-managed workloads", "safe stack image refreshes"], guidance: ["Prefer this over container.upgrade for stack-managed workloads."] },
  "stack.delete": { category: "stack", summary: "Delete a stack.", required_fields: ["endpoint_id", "stack_id"], mutating: true, destructive: true },
  "container.list": { category: "container", summary: "List containers for an endpoint.", required_fields: ["endpoint_id"], optional_fields: ["unmanaged"] },
  "container.resolve": { category: "container", summary: "Resolve a container by ID or name.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"], recommended_for: ["finding a precise container ID before inspect, delete, or upgrade flows"] },
  "container.inspect": { category: "container", summary: "Inspect a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.compose": { category: "container", summary: "Export a container as practical compose YAML.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.start": { category: "container", summary: "Start a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"], mutating: true },
  "container.stop": { category: "container", summary: "Stop a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "timeout_sec"], mutating: true },
  "container.restart": { category: "container", summary: "Restart a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "timeout_sec"], mutating: true },
  "container.logs": { category: "container", summary: "Read bounded container logs.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "tail", "timestamps"] },
  "container.mounts": { category: "container", summary: "Inspect container mount attachments.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name"] },
  "container.exec": { category: "container", summary: "Run a bounded non-interactive exec command.", required_fields: ["endpoint_id", "command"], optional_fields: ["container_id", "name", "command_args", "shell_family"], mutating: true, recommended_for: ["one-off diagnostics inside a container without opening a terminal"], guidance: ["Keep commands short and non-interactive; streaming attach is not supported here.", "Use shell_family=powershell for Windows containers and shell_family=posix for Linux/Unix containers."] },
  "container.upgrade": { category: "container", summary: "Upgrade one standalone container in place with rollback on start failure.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "image", "timeout_sec", "force"], mutating: true, recommended_for: ["refreshing standalone containers"], guidance: ["Prefer stack.pull_and_update for stack-managed workloads."] },
  "container.upgrade_many": { category: "container", summary: "Upgrade multiple standalone containers using the single-container upgrade flow.", required_fields: ["endpoint_id", "names"], optional_fields: ["image", "timeout_sec", "force"], mutating: true, recommended_for: ["batch refreshing standalone containers"], guidance: ["Prefer stack.pull_and_update for stack-managed workloads."] },
  "container.delete": { category: "container", summary: "Delete a container.", required_fields: ["endpoint_id"], optional_fields: ["container_id", "name", "force"], mutating: true, destructive: true },
  "image.list": { category: "image", summary: "List endpoint images.", required_fields: ["endpoint_id"] },
  "image.inspect": { category: "image", summary: "Inspect one image.", required_fields: ["endpoint_id", "image"] },
  "image.pull": { category: "image", summary: "Pull an image.", required_fields: ["endpoint_id", "image"], mutating: true },
  "image.delete": { category: "image", summary: "Delete an image.", required_fields: ["endpoint_id", "image"], optional_fields: ["force"], mutating: true, destructive: true },
  "image.prune": { category: "image", summary: "Prune images.", required_fields: ["endpoint_id"], optional_fields: ["all_unused"], mutating: true, destructive: true },
  "image.update_check": { category: "image", summary: "Compare local and remote image digests.", required_fields: ["endpoint_id", "image"], recommended_for: ["update planning", "drift checks before pull or upgrade"] },
  "network.list": { category: "network", summary: "List Docker networks.", required_fields: ["endpoint_id"] },
  "network.inspect": { category: "network", summary: "Inspect a Docker network.", required_fields: ["endpoint_id"], optional_fields: ["network_id", "name"] },
  "network.create": { category: "network", summary: "Create a Docker network.", required_fields: ["endpoint_id", "name"], optional_fields: ["driver", "internal", "attachable", "enable_ipv6", "labels", "options"], mutating: true },
  "network.delete": { category: "network", summary: "Delete a Docker network.", required_fields: ["endpoint_id"], optional_fields: ["network_id", "name"], mutating: true, destructive: true },
  "volume.list": { category: "volume", summary: "List Docker volumes.", required_fields: ["endpoint_id"] },
  "volume.inspect": { category: "volume", summary: "Inspect a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name"] },
  "volume.create": { category: "volume", summary: "Create a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name", "driver", "labels", "options"], mutating: true },
  "volume.delete": { category: "volume", summary: "Delete a Docker volume.", required_fields: ["endpoint_id"], optional_fields: ["volume_name", "name", "force"], mutating: true, destructive: true },
  "volume.prune": { category: "volume", summary: "Prune unused Docker volumes.", required_fields: ["endpoint_id"], mutating: true, destructive: true },
};

function resolveRuntimePortainerWorkflowName(value: string): PortainerWorkflowName {
  return value as PortainerWorkflowName;
}

function uniqueStrings(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))];
}

function normalizeCategoryFilter(value: string | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || undefined;
}

function getPortainerWorkflowEntries(category?: string): Array<{ name: string } & WorkflowCapabilitySpec> {
  const entries = Object.entries(PORTAINER_WORKFLOW_CAPABILITIES)
    .map(([name, spec]) => ({ name, ...spec }))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!category) return entries;
  const filtered = entries.filter((entry) => entry.category === category);
  if (filtered.length === 0) {
    throw new Error(`Unknown Portainer workflow family: ${category}`);
  }
  return filtered;
}

function buildPortainerFamilySummaries(): WorkflowFamilySummary[] {
  return Object.entries(PORTAINER_WORKFLOW_FAMILY_SUMMARIES)
    .map(([name, summary]) => {
      const entries = getPortainerWorkflowEntries(name);
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

function getPortainerDefaultRecommendedFor(category: string): string[] {
  switch (category) {
    case "container":
    case "stack":
      return ["day-2 application operations", "maintenance and rollout work"];
    case "endpoint":
      return ["endpoint inventory", "Docker host inspection"];
    case "image":
      return ["image hygiene", "update planning"];
    case "network":
    case "volume":
      return ["Docker environment inspection", "configuration changes"];
    default:
      return [];
  }
}

function getPortainerDefaultSeeAlso(workflow: string, category: string): string[] {
  switch (category) {
    case "endpoint":
      return ["endpoint.list", "endpoint.resolve", "endpoint.inspect", "endpoint.docker_info", "endpoint.system_df"];
    case "stack":
      return ["stack.list", "stack.resolve", "stack.file", "stack.pull_and_update", "stack.update"];
    case "container":
      return ["container.list", "container.resolve", "container.inspect", "container.logs", "container.upgrade"];
    case "image":
      return ["image.list", "image.inspect", "image.update_check", "image.pull", "image.prune"];
    case "network":
      return ["network.list", "network.inspect", "network.create", "network.delete"];
    case "volume":
      return ["volume.list", "volume.inspect", "volume.create", "volume.delete"];
    default:
      return getPortainerWorkflowEntries(category).map((entry) => entry.name);
  }
}

function getPortainerDefaultGuidance(workflow: string, spec: WorkflowCapabilitySpec): string[] {
  const guidance = [...(spec.guidance || [])];
  if (spec.category === "endpoint" && spec.required_fields.includes("endpoint_id") && workflow !== "endpoint.resolve") {
    guidance.push("Use endpoint.resolve first when starting from an endpoint name.");
  }
  if (spec.category === "stack" && (spec.optional_fields?.includes("stack_name") || spec.optional_fields?.includes("name"))) {
    guidance.push("Use stack.resolve first when starting from a stack name.");
  }
  if (spec.category === "container" && spec.optional_fields?.includes("name")) {
    guidance.push("Use container.resolve first when a container name may be ambiguous.");
  }
  if (workflow === "container.logs") {
    guidance.push("Use tail to keep log results small.");
  }
  if (workflow === "image.update_check") {
    guidance.push("Run this before upgrade/pull work when you only need to know whether an update exists.");
  }
  if (spec.mutating) {
    guidance.push("Inspect current state first if you need a pre-change snapshot.");
  }
  if (spec.destructive) {
    guidance.push("Double-check identifiers and scope before destructive workflows.");
  }
  return uniqueStrings(guidance);
}

function buildPortainerRequiredFieldExample(field: string, workflow: string): unknown {
  switch (field) {
    case "endpoint_id": return 2;
    case "stack_id": return 7;
    case "container_id": return "e90e34656806";
    case "network_id": return "frontend-net";
    case "name": return workflow.startsWith("endpoint.") ? "diskstation" : workflow.startsWith("network.") ? "frontend" : workflow.startsWith("volume.") ? "gitea-data" : "gitea";
    case "image": return "gitea/gitea:latest";
    case "volume_name": return "gitea-data";
    case "stack_name": return "gitea";
    case "stack_file_content": return "services:\n  app:\n    image: nginx:latest\n";
    case "command": return "echo";
    case "command_args": return ["ok"];
    case "driver": return workflow.startsWith("volume.") ? "local" : "bridge";
    case "timeout_sec": return 20;
    case "names": return ["gitea", "registry"];
    default: return `<${field}>`;
  }
}

function buildPortainerCommonOptionalExample(workflow: string): Record<string, unknown> {
  switch (workflow) {
    case "endpoint.resolve":
      return { name: "diskstation" };
    case "stack.resolve":
    case "stack.file":
    case "stack.pull_and_update":
      return { endpoint_id: 2, stack_name: "gitea" };
    case "container.inspect":
    case "container.compose":
    case "container.mounts":
    case "container.start":
    case "container.stop":
    case "container.restart":
    case "container.delete":
    case "container.upgrade":
      return { name: "gitea" };
    case "container.logs":
      return { name: "gitea", tail: 200, timestamps: true };
    case "container.exec":
      return { name: "gitea", command_args: ["ok"], shell_family: "posix" };
    case "container.upgrade_many":
      return { timeout_sec: 20 };
    case "image.prune":
      return { all_unused: true };
    case "network.inspect":
    case "network.delete":
      return { name: "frontend" };
    case "network.create":
      return { driver: "bridge", attachable: true };
    case "volume.inspect":
    case "volume.delete":
      return { volume_name: "gitea-data" };
    case "volume.create":
      return { volume_name: "gitea-data", driver: "local" };
    default:
      return {};
  }
}

function buildPortainerWorkflowExamples(workflow: string, spec: WorkflowCapabilitySpec): Array<Record<string, unknown>> {
  const base: Record<string, unknown> = { action: "workflow", workflow };
  for (const field of spec.required_fields) {
    base[field] = buildPortainerRequiredFieldExample(field, workflow);
  }
  const common = { ...base, ...buildPortainerCommonOptionalExample(workflow), ...(spec.example_fields || {}) };
  const serializedBase = JSON.stringify(base);
  const serializedCommon = JSON.stringify(common);
  return serializedBase === serializedCommon ? [base] : [base, common];
}

function buildPortainerRequestExamples(): Array<Record<string, unknown>> {
  return [
    {
      action: "request",
      method: "GET",
      path: "/api/endpoints",
      purpose: "List endpoints before resolving a target endpoint ID.",
    },
    {
      action: "request",
      method: "GET",
      path: "/api/endpoints/2/docker/containers/json",
      query: { all: true },
      purpose: "List endpoint containers through the raw Docker-compatible Portainer proxy path.",
    },
    {
      action: "request",
      method: "GET",
      path: "/api/endpoints/2/docker/containers/04572d64c639/stats",
      query: { stream: false },
      purpose: "Fetch one bounded Docker stats snapshot for charting/reporting without opening a streaming attach session.",
    },
    {
      action: "request",
      method: "GET",
      path: "/api/stacks/7/file",
      query: { endpointId: 2 },
      purpose: "Fetch stack compose content when you know the stack and endpoint IDs.",
    },
    {
      action: "request",
      requests: [
        { label: "endpoints", method: "GET", path: "/api/endpoints" },
        { label: "diskstation containers", method: "GET", path: "/api/endpoints/2/docker/containers/json", query: { all: 1 } },
      ],
      throttle_ms: 250,
      retries: 2,
      retry_delay_ms: 1000,
      output_path: "exports/portainer-request-batch.json",
      purpose: "Run a small sequential batch, keep spacing between attempts, and persist the combined result to a file.",
    },
  ];
}

function buildPortainerRequestHelpPayload(): Record<string, unknown> {
  return {
    action: "request_help",
    request_contract: {
      summary: "Use request for raw Portainer API calls when the workflow surface is too narrow or when you need a Docker-proxy-style endpoint path. Provide either path for one request or requests for a sequential batch.",
      required_fields: ["path or requests"],
      optional_fields: ["method", "query", "body", "body_mode", "headers", "requests", "pause_ms", "throttle_ms", "timeout_ms", "retries", "retry_delay_ms", "retry_backoff_factor", "fail_fast", "output_path", "output_format"],
      defaults: {
        method: "GET",
        body_mode: "json",
      },
      path_rules: [
        "path may be given with or without a leading slash; the runtime normalizes it against the configured Portainer base URL.",
        "Use query for endpointId and list-style filters.",
        "Use body_mode=text only when an endpoint expects raw text instead of JSON.",
        "Use requests for sequential batches; each item supports its own method/path/query/body/body_mode/headers/label.",
        "Batched requests run sequentially with configurable pause_ms, throttle_ms, timeout_ms, retries, and retry_delay_ms.",
        "Use output_path to persist either a single request result or a full batch result to a workspace file.",
      ],
      response_shape: {
        content_text: "Success summary plus the full inline Response body when bounded, otherwise a tool-output handle/path plus preview.",
        details_path: "details.response",
        fields: {
          status: "HTTP status number",
          method: "normalized HTTP method",
          path: "normalized Portainer API path starting with /",
          body: "parsed JSON body when possible, otherwise raw text",
        },
        body_access_path: "details.response.body",
        batch_details_path: "details.batch",
        batch_results_access_path: "details.batch.results",
        overflow_tool_output_access_path: "details.response_tool_output or details.batch_tool_output",
        output_file_access_path: "details.output_file",
      },
      examples: buildPortainerRequestExamples(),
      inventory_patterns: [
        {
          goal: "Inspect a live Docker surface through Portainer",
          steps: [
            "GET /api/endpoints to resolve an endpoint ID.",
            "GET /api/endpoints/{id}/docker/... for Docker-native list/inspect surfaces not yet modeled as workflows.",
            "Render the returned inventory/log/config data locally as needed.",
          ],
        },
        {
          goal: "Collect bounded container memory/CPU stats for charting",
          steps: [
            "Use workflow endpoint.list or GET /api/endpoints to pick a reachable endpoint.",
            "Use workflow container.list or GET /api/endpoints/{id}/docker/containers/json?all=1 to resolve target containers.",
            "GET /api/endpoints/{id}/docker/containers/{containerId}/stats?stream=false for one non-streaming snapshot per container.",
            "Aggregate memory/cpu/network fields locally into a chart/report artifact.",
          ],
        },
      ],
      next_steps: [
        "Use capabilities or recommend first if you are not sure whether a native workflow already exists.",
        "Use workflow_help for a curated workflow before falling back to request when the task fits a native flow.",
      ],
    },
  };
}

function buildPortainerContractPayload(): Record<string, unknown> {
  return {
    tool: "portainer",
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
      set: ["base_url", "api_token_keychain", "allow_insecure_tls"],
      clear: ["chat_jid"],
      discover: ["env hints", "keychain hints"],
    },
    request_contract: buildPortainerRequestHelpPayload().request_contract,
    workflow_contract: {
      discovery: "Use capabilities/recommend/workflow_help to choose one workflow before execution.",
      response_shape: {
        content_text: "Workflow completion summary plus the full inline Result when bounded, otherwise a tool-output handle/path plus preview.",
        details_path: "details.response",
        fields: {
          workflow: "canonical workflow name",
          result: "workflow-specific result payload",
        },
        result_access_path: "details.response.result",
        overflow_tool_output_access_path: "details.result_tool_output",
      },
    },
  };
}

function buildPortainerCapabilitiesPayload(options?: { category?: string; include_workflows?: boolean }): Record<string, unknown> {
  const category = normalizeCategoryFilter(options?.category);
  const familySummaries = buildPortainerFamilySummaries();
  if (category && !familySummaries.some((entry) => entry.name === category)) {
    throw new Error(`Unknown Portainer workflow family: ${category}`);
  }
  const includeWorkflows = options?.include_workflows === true || Boolean(category);
  const entries = includeWorkflows ? getPortainerWorkflowEntries(category) : [];
  return {
    actions: ["get", "set", "clear", "discover", "contract", "capabilities", "workflow_help", "request_help", "recommend", "request", "workflow"],
    workflow_count: Object.keys(PORTAINER_WORKFLOW_CAPABILITIES).length,
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
      "Use request_help when you need raw API request fields, response shape, Docker-proxy request examples, or bounded stats-snapshot patterns for charting.",
      "Set include_examples=true on workflow_help only when you need example payloads.",
    ],
  };
}

function getPortainerWorkflowHelp(value: string | undefined, options?: { include_examples?: boolean }): { canonical_workflow: string; runtime_workflow: PortainerWorkflowName; spec: WorkflowCapabilitySpec; recommended_for: string[]; see_also: string[]; guidance: string[]; examples?: Array<Record<string, unknown>> } {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new Error("Provide workflow for action=workflow_help.");
  const spec = PORTAINER_WORKFLOW_CAPABILITIES[raw];
  if (!spec) throw new Error(`Unknown Portainer workflow: ${raw}`);
  const recommendedFor = uniqueStrings([...(spec.recommended_for || []), ...getPortainerDefaultRecommendedFor(spec.category)]);
  const seeAlso = uniqueStrings([...(spec.see_also || []), ...getPortainerDefaultSeeAlso(raw, spec.category)]).filter((entry) => entry !== raw).slice(0, 5);
  const guidance = getPortainerDefaultGuidance(raw, spec);
  return {
    canonical_workflow: raw,
    runtime_workflow: resolveRuntimePortainerWorkflowName(raw),
    spec,
    recommended_for: recommendedFor,
    see_also: seeAlso,
    guidance,
    ...(options?.include_examples ? { examples: buildPortainerWorkflowExamples(raw, spec) } : {}),
  };
}

function tokenizeIntent(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).map((entry) => entry.trim()).filter((entry) => entry.length >= 2);
}

function scorePortainerWorkflowForIntent(workflow: string, spec: WorkflowCapabilitySpec, tokens: string[]): number {
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
  if (tokens.some((token) => ["update", "upgrade", "refresh"].includes(token)) && workflow === "stack.pull_and_update") score += 8;
  if (tokens.some((token) => ["update", "upgrade", "refresh"].includes(token)) && workflow === "container.upgrade") score += 6;
  if (tokens.some((token) => ["logs", "log"].includes(token)) && workflow === "container.logs") score += 8;
  if (tokens.some((token) => ["exec", "command", "diagnostic"].includes(token)) && workflow === "container.exec") score += 8;
  if (tokens.some((token) => ["compose", "stackfile", "yaml"].includes(token)) && workflow === "stack.file") score += 8;
  return score;
}

function buildPortainerRecommendations(intent: string | undefined, options?: { category?: string; max_recommendations?: number }): Record<string, unknown> {
  const rawIntent = typeof intent === "string" ? intent.trim() : "";
  if (!rawIntent) throw new Error("Provide intent for action=recommend.");
  const category = normalizeCategoryFilter(options?.category);
  const tokens = tokenizeIntent(rawIntent);
  const entries = getPortainerWorkflowEntries(category)
    .map((entry) => {
      const help = getPortainerWorkflowHelp(entry.name);
      return {
        workflow: entry.name,
        category: entry.category,
        summary: entry.summary,
        score: scorePortainerWorkflowForIntent(entry.name, entry, tokens),
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

const PORTAINER_TOOL_HINT = [
  "## Portainer",
  "Use portainer to inspect or change the Portainer API profile for the current session.",
  "Use portainer discover to find a likely existing Portainer instance from keychain/env hints.",
  "Use portainer capabilities to list workflow families, portainer recommend for intent-based shortlists, and portainer workflow_help for one workflow's fields/guidance.",
  "Use portainer contract for the overall tool contract and request_help for raw request fields, response shape, Docker-proxy request examples, and bounded stats-snapshot patterns.",
  "Use portainer request for ad-hoc Portainer API calls and portainer workflow for reusable endpoint/stack/container/image/network/volume orchestration.",
  "Keep the raw request path available so future inventory/charting and other Portainer API surfaces do not need bespoke runtime primitives.",
].join("\n");

function normalizeChatJid(value: string | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || getChatJid("web:default");
}

function buildWorkflowSummary(workflow: string, result: PortainerWorkflowResponse): string {
  const maybeArrayCount = Array.isArray(result.result) ? ` (${result.result.length} items)` : "";
  return `Portainer workflow ${workflow} completed${maybeArrayCount}.`;
}

function startPortainerUiProgress(ctx: { hasUI?: boolean; ui?: { setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void; setWorkingMessage: (message?: string) => void } }, message: string): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingIndicator({ frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], intervalMs: 90 });
  ctx.ui.setWorkingMessage(message);
}

function finishPortainerUiProgress(ctx: { hasUI?: boolean; ui?: { setWorkingIndicator: (options?: { frames?: string[]; intervalMs?: number }) => void; setWorkingMessage: (message?: string) => void } }): void {
  if (!ctx?.hasUI || !ctx.ui) return;
  ctx.ui.setWorkingMessage(undefined);
  ctx.ui.setWorkingIndicator({ frames: [] });
}

export const portainerTool: ExtensionFactory = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n${PORTAINER_TOOL_HINT}`,
  }));

  pi.registerTool({
    name: "portainer",
    label: "portainer",
    description: "Get, set, or clear the session-scoped Portainer API profile, perform ad-hoc API requests, or run common Portainer workflows.",
    promptSnippet: "portainer: inspect/update the current session Portainer API profile, send ad-hoc API requests, or run common endpoint/stack/container/image/volume workflows.",
    parameters: PortainerToolSchema,
    async execute(_toolCallId, params, _signal, _update, ctx): Promise<PortainerToolResult> {
      const chatJid = normalizeChatJid(params.chat_jid);

      if (params.action === "contract") {
        const payload = buildPortainerContractPayload();
        return {
          content: [{
            type: "text",
            text: "Portainer contract: discover → capabilities/recommend → workflow_help → workflow/request. Use request_help for raw request examples and response-shape guidance.",
          }],
          details: { action: "contract", chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "capabilities") {
        const payload = buildPortainerCapabilitiesPayload({
          category: params.category,
          include_workflows: params.include_workflows,
        });
        const familyCount = Array.isArray(payload.workflow_families) ? payload.workflow_families.length : 0;
        const filteredCount = typeof payload.matching_workflow_count === "number" ? payload.matching_workflow_count : null;
        return {
          content: [{
            type: "text",
            text: typeof payload.category === "string"
              ? `Portainer family ${payload.category} exposes ${filteredCount ?? 0} workflows. Use workflow_help for one workflow and include_examples=true only when needed.`
              : `Portainer supports ${String(payload.workflow_count)} documented workflows across ${familyCount} families. Use category to drill into one family without pulling the whole surface.`,
          }],
          details: { action: "capabilities", chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "workflow_help") {
        const help = getPortainerWorkflowHelp(params.workflow, { include_examples: params.include_examples === true });
        return {
          content: [{ type: "text", text: `Portainer workflow ${help.canonical_workflow}: ${help.spec.summary}` }],
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
        const payload = buildPortainerRequestHelpPayload();
        return {
          content: [{
            type: "text",
            text: "Portainer request help: provide path for one request or requests for a sequential batch; method defaults to GET; use details.request_contract for examples and response-shape guidance.",
          }],
          details: { chat_jid: chatJid, ...payload },
        };
      }

      if (params.action === "recommend") {
        const payload = buildPortainerRecommendations(params.intent, {
          category: params.category,
          max_recommendations: params.max_recommendations,
        });
        const recommendationCount = typeof payload.recommendation_count === "number" ? payload.recommendation_count : 0;
        const intent = typeof payload.intent === "string" ? payload.intent : "";
        return {
          content: [{
            type: "text",
            text: recommendationCount
              ? `Portainer found ${String(recommendationCount)} workflow recommendation(s) for \"${intent}\".`
              : `Portainer found no strong workflow matches for \"${intent}\".`,
          }],
          details: { action: "recommend", chat_jid: chatJid, ...payload },
        };
      }

      const handlers = registeredHandlers;
      if (params.action === "get") {
        const config = handlers?.get(chatJid) ?? kvGetConfig(chatJid);
        if (!config) {
          return {
            content: [{ type: "text", text: `No Portainer config stored for ${chatJid}.` }],
            details: { action: "get", chat_jid: chatJid, configured: false, config: null },
          };
        }
        return {
          content: [{
            type: "text",
            text: `Portainer config for ${chatJid}: ${config.base_url} (key ${config.api_token_keychain}, insecure TLS ${config.allow_insecure_tls ? "on" : "off"}).`,
          }],
          details: { action: "get", chat_jid: chatJid, configured: true, config },
        };
      }

      if (params.action === "set") {
        const result = handlers ? await handlers.set(chatJid, {
          base_url: typeof params.base_url === "string" ? params.base_url.trim() : "",
          api_token_keychain: typeof params.api_token_keychain === "string" ? params.api_token_keychain.trim() : "",
          allow_insecure_tls: params.allow_insecure_tls ?? true,
        }) : kvSetConfig(chatJid, {
          base_url: typeof params.base_url === "string" ? params.base_url.trim() : "",
          api_token_keychain: typeof params.api_token_keychain === "string" ? params.api_token_keychain.trim() : "",
          allow_insecure_tls: params.allow_insecure_tls ?? true,
        });
        return {
          content: [{
            type: "text",
            text: `Stored Portainer config for ${chatJid}: ${result.config.base_url} (key ${result.config.api_token_keychain}). Applies immediately.`,
          }],
          details: {
            action: "set",
            chat_jid: chatJid,
            updated: true,
            apply_timing: result.apply_timing,
            config: result.config,
          },
        };
      }

      if (params.action === "clear") {
        const result = handlers ? await handlers.clear(chatJid) : kvClearConfig(chatJid);
        return {
          content: [{
            type: "text",
            text: result.deleted
              ? `Cleared Portainer config for ${chatJid}. Applies immediately.`
              : `No Portainer config existed for ${chatJid}. Applies immediately.`,
          }],
          details: {
            action: "clear",
            chat_jid: chatJid,
            deleted: result.deleted,
            apply_timing: result.apply_timing,
          },
        };
      }

      if (params.action === "discover") {
        startPortainerUiProgress(ctx, "Portainer: discovering configured instances…");
        try {
          const discovery = await discoverPortainerInstances();
          return {
            content: [{
              type: "text",
              text: discovery.default_candidate
                ? `Discovered ${discovery.candidates.length} Portainer candidate(s); default ${discovery.default_candidate.api_token_keychain}${discovery.default_candidate.base_url ? ` @ ${discovery.default_candidate.base_url}` : ""}.`
                : "No Portainer instances discovered from current keychain/env hints.",
            }],
            details: {
              action: "discover",
              chat_jid: chatJid,
              ...discovery,
            },
          };
        } finally {
          finishPortainerUiProgress(ctx);
        }
      }

      if (params.action === "workflow") {
        if (!params.workflow) {
          return {
            content: [{ type: "text", text: "Provide workflow for action=workflow." }],
            details: { action: "workflow", chat_jid: chatJid, ok: false },
          };
        }

        const help = getPortainerWorkflowHelp(params.workflow);
        startPortainerUiProgress(ctx, `Portainer: running workflow ${help.canonical_workflow}…`);
        try {
          const workflowResult = await (handlers?.workflow ?? kvWorkflow)(chatJid, {
          workflow: help.runtime_workflow,
          ...(typeof params.endpoint_id === "number" ? { endpoint_id: params.endpoint_id } : {}),
          ...(typeof params.stack_id === "number" ? { stack_id: params.stack_id } : {}),
          ...(typeof params.container_id === "string" ? { container_id: params.container_id } : {}),
          ...(typeof params.network_id === "string" ? { network_id: params.network_id } : {}),
          ...(typeof params.name === "string" ? { name: params.name } : {}),
          ...(typeof params.stack_name === "string" ? { stack_name: params.stack_name } : {}),
          ...(typeof params.stack_file_content === "string" ? { stack_file_content: params.stack_file_content } : {}),
          ...(typeof params.image === "string" ? { image: params.image } : {}),
          ...(typeof params.volume_name === "string" ? { volume_name: params.volume_name } : {}),
          ...(typeof params.unmanaged === "boolean" ? { unmanaged: params.unmanaged } : {}),
          ...(typeof params.force === "boolean" ? { force: params.force } : {}),
          ...(typeof params.all_unused === "boolean" ? { all_unused: params.all_unused } : {}),
          ...(typeof params.tail === "number" ? { tail: params.tail } : {}),
          ...(typeof params.timestamps === "boolean" ? { timestamps: params.timestamps } : {}),
          ...(typeof params.timeout_sec === "number" ? { timeout_sec: params.timeout_sec } : {}),
          ...(typeof params.command === "string" ? { command: params.command } : {}),
          ...(Array.isArray(params.command_args) ? { command_args: params.command_args } : {}),
          ...(params.shell_family === "powershell" || params.shell_family === "posix" ? { shell_family: params.shell_family } : {}),
          ...(typeof params.driver === "string" ? { driver: params.driver } : {}),
          ...(typeof params.internal === "boolean" ? { internal: params.internal } : {}),
          ...(typeof params.attachable === "boolean" ? { attachable: params.attachable } : {}),
          ...(typeof params.enable_ipv6 === "boolean" ? { enable_ipv6: params.enable_ipv6 } : {}),
          ...(params.labels ? { labels: params.labels } : {}),
          ...(params.options ? { options: params.options } : {}),
          ...(Array.isArray(params.names) ? { names: params.names } : {}),
        });

        const presented = presentStructuredToolValue(
          buildWorkflowSummary(help.canonical_workflow, workflowResult),
          "Result",
          workflowResult.result,
          `portainer:workflow:${help.canonical_workflow}`,
        );

          return {
            content: [{ type: "text", text: presented.text }],
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
          finishPortainerUiProgress(ctx);
        }
      }

      const outputPath = typeof params.output_path === "string" ? params.output_path.trim() : "";
      const outputFormat = params.output_format === "jsonl" ? "jsonl" : "json";
      const requestBatch = Array.isArray(params.requests) ? params.requests : [];
      if (requestBatch.length > 0) {
        const batchRequests = requestBatch.map((entry, index) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`Portainer batch request entry ${index + 1} must be an object.`);
          }
          const item = entry as Record<string, unknown>;
          const batchPath = typeof item.path === "string" ? item.path.trim() : "";
          if (!batchPath) {
            throw new Error(`Portainer batch request entry ${index + 1} requires path.`);
          }
          const batchBodyMode = item.body_mode === "json" || item.body_mode === "text"
            ? item.body_mode
            : undefined;
          return {
            ...(typeof item.label === "string" && item.label.trim() ? { label: item.label.trim() } : {}),
            method: typeof item.method === "string" && item.method.trim() ? item.method.trim().toUpperCase() : "GET",
            path: batchPath,
            ...(item.query !== undefined ? { query: item.query } : {}),
            ...(item.body !== undefined ? { body: item.body } : {}),
            ...(batchBodyMode ? { body_mode: batchBodyMode as "json" | "text" } : {}),
            ...(item.headers && typeof item.headers === "object" && !Array.isArray(item.headers) ? { headers: item.headers as Record<string, string> } : {}),
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
          timeout_label_prefix: "Portainer batch",
          getLabel: (request) => request.label || `${request.method} ${request.path}`,
        });

        const presented = presentStructuredToolValue(
          `Portainer request batch ${batch.ok ? "completed" : "completed with failures"}: ${batch.success_count} succeeded, ${batch.failure_count} failed across ${batch.request_count} request(s).${batch.stopped_early ? " Stopped early due to fail_fast." : ""}`,
          "Batch result",
          batch,
          "portainer:request:batch",
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
        ...(params.headers ? { headers: params.headers } : {}),
      });

      const presented = presentStructuredToolValue(
        `Portainer ${response.method} ${response.path} succeeded with HTTP ${response.status}.`,
        "Response",
        response.body,
        `portainer:request:${response.method}:${response.path}`,
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
