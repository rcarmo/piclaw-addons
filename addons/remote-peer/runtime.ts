import { getPeerService } from "./runtime-service.js";
// Piclaw loads this contribution once at process startup, independently of agent sessions.
// runtime-service registers process cleanup through lifecycle API v1.
const service = getPeerService();
await service.start();
// No external peer HTTP routes are registered. Peer packets arrive only over Iroh.
export {};
