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

export type ChatTransportRequest = {
  source_chat_jid: string;
  address: BangChatAddress;
  content: string;
  mode: "auto" | "queue" | "steer";
  idempotency_key?: string;
  in_reply_to?: string;
};

export type ChatTransport = {
  id: string;
  kind: "bang";
  send(request: ChatTransportRequest): Promise<Record<string, unknown>>;
};

export type ExternalRouteRegistration = {
  addonId: string;
  prefix: string;
  methods: string[];
  maxBodyBytes: number;
  handler(req: Request, pathname: string, context: Record<string, unknown>): Response | Promise<Response>;
};

export type PiclawRuntimeApi = {
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
  externalRoutes?: {
    version: number;
    register(registration: ExternalRouteRegistration): () => void;
  };
};

export function getPiclawRuntimeApi(): PiclawRuntimeApi | null {
  return ((globalThis as typeof globalThis & { __piclaw_runtime?: PiclawRuntimeApi }).__piclaw_runtime) ?? null;
}

export function requirePiclawRuntimeApi(): Required<Pick<PiclawRuntimeApi, "messaging" | "externalRoutes">> {
  const api = getPiclawRuntimeApi();
  if (api?.messaging?.version !== 1) throw new Error("Remote Peer requires Piclaw messaging API v1.");
  if (api?.externalRoutes?.version !== 1) throw new Error("Remote Peer requires Piclaw external routes API v1.");
  return { messaging: api.messaging, externalRoutes: api.externalRoutes };
}
