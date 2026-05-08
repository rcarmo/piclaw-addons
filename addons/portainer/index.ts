/**
 * piclaw-addon-portainer — Portainer management tool.
 *
 * Provides the `portainer` tool for session-scoped API config, ad-hoc requests,
 * and structured endpoint/stack/container/image/network/volume workflows.
 */
export {
  setPortainerToolHandlers,
  type PortainerRequestResult,
  type PortainerToolHandlers,
} from "./extension.js";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { portainerTool } from "./extension.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function portainerPackagedExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [
      join(baseDir, "skills", "portainer-container-compare-chart", "SKILL.md"),
    ],
  }));

  return portainerTool(pi);
}
