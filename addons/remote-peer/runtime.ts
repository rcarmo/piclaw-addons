import { requirePiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { getPairingService } from "./pairing/runtime-service.js";
import { getMessagingService } from "./messaging/runtime-service.js";
import { getRosterService } from "./messaging/runtime-roster.js";
import { getWorkService, startWorkCallbackRetry } from "./work/runtime-service.js";
import { runRemotePeerMaintenance } from "./store/maintenance.js";

const ADDON_ID = "remote-peer";
const runtime = requirePiclawRuntimeApi();
const dataDir = runtime.messaging.getAddonDataDir(ADDON_ID);
const foundation = getRemotePeerFoundation(dataDir);
const messaging = getMessagingService(foundation, runtime.messaging);
const roster = getRosterService(foundation, runtime.messaging);
const work = getWorkService(foundation, runtime);
const pairing = getPairingService(foundation, { messaging, roster, work });

foundation.store.integrityCheck();
runRemotePeerMaintenance(foundation.store.db);
startWorkCallbackRetry(work);
runtime.messaging.registerChatTransport({
  id: ADDON_ID,
  kind: "bang",
  directory: () => messaging.directory(),
  validate: request => messaging.validate(request),
  send: request => messaging.send(request),
});
runtime.registerStatusPanelProvider?.({
  key: ADDON_ID,
  getPayload: () => {
    foundation.store.integrityCheck();
    const peers = pairing.repository.listPeers();
    return {
      enabled: foundation.loadConfig().enabled,
      database: "ok",
      schema_version: foundation.store.db.query("SELECT MAX(version) AS version FROM schema_migrations").get()?.version ?? 0,
      paired: peers.filter(peer => peer.status === "paired").length,
      pending: pairing.repository.listInbound().length,
      failed_receipts: messaging.listOutbound().filter(message => message.status === "failed").length
        + messaging.listInbound().filter(message => message.status === "failed").length,
      pending_work: work.listInbox().length,
      callback_retries: work.repository.listDueCallbacks(new Date().toISOString()).length,
      fingerprint: foundation.identity.fingerprint,
      generated_at: new Date().toISOString(),
    };
  },
});
runtime.externalRoutes.register({
  addonId: ADDON_ID,
  prefix: "/api/addons/remote-peer/v1",
  methods: ["POST"],
  maxBodyBytes: 32 * 1024 * 1024,
  bodyMode: "stream",
  handler: (req, pathname) => pairing.handle(req, pathname),
});

export {};
