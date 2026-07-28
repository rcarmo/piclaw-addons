import { loadOrCreateRemotePeerIdentity, type RemotePeerIdentity } from "./identity.js";
import { openRemotePeerStore, type RemotePeerStore } from "./store/index.js";
import { type RemotePeerConfig } from "./config.js";

export interface RemotePeerFoundation {
  dataDir: string;
  identity: RemotePeerIdentity;
  store: RemotePeerStore;
  loadConfig(): RemotePeerConfig;
  saveConfig(config: RemotePeerConfig): RemotePeerConfig;
  close(): void;
}

let foundation: RemotePeerFoundation | null = null;

export function getRemotePeerFoundation(dataDir: string): RemotePeerFoundation {
  if (foundation) {
    if (foundation.dataDir !== dataDir) throw new Error("Remote-peer foundation is already open for another data directory.");
    return foundation;
  }
  const store = openRemotePeerStore(dataDir);
  try {
    const identity = loadOrCreateRemotePeerIdentity(dataDir);
    foundation = {
      dataDir,
      identity,
      store,
      loadConfig: () => store.loadConfig(),
      saveConfig: (config) => store.saveConfig(config),
      close() {
        if (foundation !== this) return;
        store.close();
        foundation = null;
      },
    };
    return foundation;
  } catch (error) {
    store.close();
    throw error;
  }
}

export function closeRemotePeerFoundation(): void {
  foundation?.close();
}

export function resetRemotePeerFoundationForTests(): void {
  closeRemotePeerFoundation();
}
