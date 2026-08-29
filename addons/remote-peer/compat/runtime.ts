export type RuntimeAgentMessageResult = {
  status: "ok";
  chat_jid: string;
  row_id?: number | null;
  thread_id: number | null;
  queued?: "followup" | "steer";
  created: boolean;
};

export type BangChatAddress = {
  kind: "bang";
  raw: string;
  peer: string;
  target: string;
};

export type ChatTransportAttachment = {
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  data: Uint8Array;
  source_media_id?: number;
};

export type ChatTransportRequest = {
  source_chat_jid: string;
  source_agent_name?: string;
  source_agent_display_name?: string;
  address: BangChatAddress;
  content: string;
  mode: "auto" | "queue" | "steer";
  attachments?: ChatTransportAttachment[];
  idempotency_key?: string;
  in_reply_to?: string;
};

export type ChatTransportDirectoryEntry = {
  address: string;
  label: string;
  peer_alias?: string;
  peer_fingerprint?: string;
  target_kind: "inbox" | "agent" | "reply";
  modes: Array<"auto" | "queue" | "steer">;
  status: "ready" | "stale" | "unreachable";
  last_seen_at?: string | null;
  attachments?: { enabled: boolean; max_files: number; max_file_bytes: number; max_total_bytes: number };
};

export type ChatTransport = {
  id: string;
  kind: "bang";
  directory?(): Promise<{ transport: string; generated_at: string; entries: ChatTransportDirectoryEntry[]; notes?: string[] }>;
  validate?(request: ChatTransportRequest): Promise<void> | void;
  send(request: ChatTransportRequest): Promise<Record<string, unknown>>;
};

export type ExternalRouteRegistration = {
  addonId: string;
  prefix: string;
  methods: string[];
  maxBodyBytes: number;
  bodyMode?: "buffer" | "stream";
  handler(req: Request, pathname: string, context: Record<string, unknown>): Response | Promise<Response>;
};

export type PiclawRuntimeApi = {
  enqueueAgentMessage?: (request: {
    chatJid: string;
    content: string;
    mode?: "auto" | "queue" | "steer";
    threadId?: number | string | null;
    source?: string;
    queuedBy?: { kind: "client" | "peer" | "system"; clientId?: string; displayName?: string };
  }) => Promise<RuntimeAgentMessageResult>;
  registerStatusPanelProvider?: (provider: {
    key: string;
    getPayload(chatJid: string): unknown | Promise<unknown>;
    runAction?(action: string, payload: Record<string, unknown>): unknown | Promise<unknown>;
  }) => () => void;
  messaging?: {
    version: number;
    registerChatTransport(transport: ChatTransport): () => void;
    getAddonDataDir(addonId: string): string;
    listAdvertisableAgents(): Promise<Array<{ agent_name: string; active: boolean }>>;
    resolveLocalTarget(input: { target_agent_name?: string; target_chat_jid?: string }): Promise<Record<string, unknown>>;
    deliverPeerMessage(input: {
      target_agent_name?: string;
      target_chat_jid?: string;
      content: string;
      attachments?: ChatTransportAttachment[];
      mode?: "auto" | "queue" | "steer";
      thread_id?: number | null;
      source: {
        peer_instance_id: string;
        peer_fingerprint: string;
        peer_alias?: string;
        agent_name?: string;
        agent_display_name?: string;
        reply_address?: string;
        message_id: string;
        in_reply_to?: string;
      };
    }): Promise<RuntimeAgentMessageResult>;
  };
  createMedia?: (filename: string, contentType: string, data: Uint8Array, thumbnail: Uint8Array | null, metadata: Record<string, unknown> | null) => number;
  getMediaById?: (id: number) => { id: number; filename: string; content_type: string; data: Uint8Array; metadata: Record<string, unknown> | null } | undefined;
  externalRoutes?: {
    version: number;
    register(registration: ExternalRouteRegistration): () => void;
  };
};

export function getPiclawRuntimeApi(): PiclawRuntimeApi | null {
  return ((globalThis as typeof globalThis & { __piclaw_runtime?: PiclawRuntimeApi }).__piclaw_runtime) ?? null;
}

export function requirePiclawRuntimeApi(): PiclawRuntimeApi & Required<Pick<PiclawRuntimeApi, "messaging" | "externalRoutes">> {
  const api = getPiclawRuntimeApi();
  if (api?.messaging?.version !== 1) throw new Error("Remote Peer requires Piclaw messaging API v1.");
  if (api?.externalRoutes?.version !== 1) throw new Error("Remote Peer requires Piclaw external routes API v1.");
  return api as PiclawRuntimeApi & Required<Pick<PiclawRuntimeApi, "messaging" | "externalRoutes">>;
}
