import type { PiclawRuntimeApi } from "../compat/runtime.js";
import type { RemotePeerFoundation } from "../foundation.js";
import { RosterService, type RosterServiceOptions } from "./roster.js";

let rosterService: RosterService | null = null;

export function getRosterService(
  foundation: RemotePeerFoundation,
  messaging: NonNullable<PiclawRuntimeApi["messaging"]>,
  options: Omit<RosterServiceOptions, "foundation" | "messaging"> = {},
): RosterService {
  if (rosterService) return rosterService;
  rosterService = new RosterService({ foundation, messaging, ...options });
  return rosterService;
}

export function resetRosterServiceForTests(): void {
  rosterService = null;
}
