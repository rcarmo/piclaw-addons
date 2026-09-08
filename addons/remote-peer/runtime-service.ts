import {
  getPiclawRuntimeApi,
  requirePiclawRuntimeApi,
} from "./compat/runtime.js";
import { PeerService } from "./service.js";
const key = Symbol.for("piclaw.remote-peer.iroh-v1.service");
type Shared = { service: PeerService; unregister: () => void };
export function getPeerService(): PeerService {
  const globals = globalThis as any;
  const old = globals[key] as Shared | undefined;
  if (old) return old.service;
  const runtime = requirePiclawRuntimeApi();
  const service = new PeerService({
    dataDir: runtime.messaging.getAddonDataDir("remote-peer"),
    runtime,
  });
  const unregister = runtime.messaging.registerChatTransport({
    id: "remote-peer",
    kind: "bang",
    directory: () => service.directory(),
    validate: (r) => service.validate(r),
    send: (r) => service.send(r),
  });
  globals[key] = { service, unregister };
  return service;
}
export async function closePeerService() {
  const globals = globalThis as any;
  const shared = globals[key] as Shared | undefined;
  if (!shared) return;
  delete globals[key];
  shared.unregister();
  await shared.service.close();
}
export function hasPeerRuntime() {
  return getPiclawRuntimeApi()?.messaging?.version === 1;
}
