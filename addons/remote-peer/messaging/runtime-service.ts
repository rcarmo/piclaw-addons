import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { MessagingService, type MessagingServiceOptions } from "./service.js";

let messagingService: MessagingService | null = null;

export function getMessagingService(
  foundation: RemotePeerFoundation,
  messaging: NonNullable<PiclawRuntimeApi["messaging"]>,
  options: Omit<MessagingServiceOptions, "foundation" | "messaging"> = {},
): MessagingService {
  if (messagingService) return messagingService;
  messagingService = new MessagingService({ foundation, messaging, ...options });
  return messagingService;
}

export function resetMessagingServiceForTests(): void {
  messagingService = null;
}
