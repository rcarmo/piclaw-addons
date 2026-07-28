import { requirePiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";

const ADDON_ID = "remote-peer";
const runtime = requirePiclawRuntimeApi();
const dataDir = runtime.messaging.getAddonDataDir(ADDON_ID);
const foundation = getRemotePeerFoundation(dataDir);

// Pairing, signed routes, and chat transport registration are added in later
// focused PRs. This startup entry establishes the owned database and identity.
foundation.store.integrityCheck();

export {};
