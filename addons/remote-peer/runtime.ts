import { getPeerService, closePeerService } from "./runtime-service.js";
// Piclaw loads this contribution once at process startup, independently of agent sessions.
const service = getPeerService();
await service.start();
process.once("beforeExit", () => {
  void closePeerService();
});
// No external peer HTTP routes are registered. Peer packets arrive only over Iroh.
export {};
