import type { RemotePeerFoundation } from "../foundation.js";
import { PairingService, type PairingServiceOptions } from "./service.js";

let pairingService: PairingService | null = null;

export function getPairingService(
  foundation: RemotePeerFoundation,
  options: Omit<PairingServiceOptions, "foundation"> = {},
): PairingService {
  if (pairingService) {
    if (options.messaging) pairingService.attachMessaging(options.messaging);
    return pairingService;
  }
  pairingService = new PairingService({ foundation, ...options });
  return pairingService;
}

export function resetPairingServiceForTests(): void {
  pairingService = null;
}
