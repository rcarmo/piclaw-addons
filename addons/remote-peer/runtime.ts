import { requirePiclawRuntimeApi } from "./compat/runtime.js";
import { getRemotePeerFoundation } from "./foundation.js";
import { getPairingService } from "./pairing/runtime-service.js";

const ADDON_ID = "remote-peer";
const runtime = requirePiclawRuntimeApi();
const dataDir = runtime.messaging.getAddonDataDir(ADDON_ID);
const foundation = getRemotePeerFoundation(dataDir);
const pairing = getPairingService(foundation);

foundation.store.integrityCheck();
runtime.externalRoutes.register({
  addonId: ADDON_ID,
  prefix: "/api/addons/remote-peer/v1",
  methods: ["POST"],
  maxBodyBytes: 32 * 1024,
  handler: (req, pathname) => pairing.handle(req, pathname),
});

export {};
