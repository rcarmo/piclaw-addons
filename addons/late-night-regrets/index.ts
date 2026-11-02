/** SDK discovery only. The durable host binds execution, settings and prompts. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { regretsResources, regretsToolDeclaration } from "./native.js";

async function unbound(): Promise<never> {
  throw new Error("Late Night Regrets requires its native durable host binding");
}

export default function lateNightRegretsExtension(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => regretsResources);
  pi.registerTool({ ...regretsToolDeclaration, execute: unbound });
  pi.registerCommand("regrets", {
    description: "Review recent human feedback within the configured budget",
    handler: unbound,
  });
}
