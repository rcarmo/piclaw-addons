import { requirePiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { getPairingService } from "./pairing/runtime-service.js";
import { getMessagingService } from "./messaging/runtime-service.js";

const ADDON_ID = "remote-peer";
const runtime = requirePiclawRuntimeApi();
const dataDir = runtime.messaging.getAddonDataDir(ADDON_ID);
const foundation = getRemotePeerFoundation(dataDir);
const messaging = getMessagingService(foundation, runtime.messaging);
const pairing = getPairingService(foundation, { messaging });

foundation.store.integrityCheck();
runtime.messaging.registerChatTransport({
  id: ADDON_ID,
  kind: "bang",
  send: request => messaging.send(request),
});
runtime.externalRoutes.register({
  addonId: ADDON_ID,
  prefix: "/api/addons/remote-peer/v1",
  methods: ["POST"],
  maxBodyBytes: 32 * 1024,
  handler: (req, pathname) => pairing.handle(req, pathname),
});

export {};
