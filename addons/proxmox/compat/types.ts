/**
 * compat/types.ts — Inlined type interfaces from piclaw runtime/src/types.ts.
 * Standalone versions for addon use without importing piclaw internals.
 */

export interface ProxmoxConfig {
  /** Owning chat/session JID. */
  chat_jid: string;
  /** Proxmox API base URL, typically ending in /api2/json. */
  base_url: string;
  /** Proxmox API token username, e.g. root@pam!piclaw. */
  username?: string;
  /** Keychain entry name containing the Proxmox API token secret. */
  api_token_keychain: string;
  /** Whether to allow insecure/self-signed TLS when calling the API. */
  allow_insecure_tls?: boolean;
  /** ISO timestamp when this config was first stored. */
  created_at?: string;
  /** ISO timestamp of the last update. */
  updated_at?: string;
}

export interface ProxmoxConfigSetResult {
  config: ProxmoxConfig;
  apply_timing: "immediate";
}

export interface ProxmoxConfigClearResult {
  deleted: boolean;
  apply_timing: "immediate";
}

export interface PortainerConfig {
  /** Owning chat/session JID. */
  chat_jid: string;
  /** Portainer API base URL. */
  base_url: string;
  /** Keychain entry name containing the Portainer API token. */
  api_token_keychain: string;
  /** Whether to allow insecure/self-signed TLS when calling the API. */
  allow_insecure_tls?: boolean;
  /** ISO timestamp when this config was first stored. */
  created_at?: string;
  /** ISO timestamp of the last update. */
  updated_at?: string;
}

export interface PortainerConfigSetResult {
  config: PortainerConfig;
  apply_timing: "immediate";
}

export interface PortainerConfigClearResult {
  deleted: boolean;
  apply_timing: "immediate";
}
