/**
 * piclaw-addon-proxmox — Proxmox VE management tool.
 *
 * Provides the `proxmox` tool for session-scoped API config, ad-hoc requests,
 * and structured VM/LXC/storage/task/metrics workflows.
 */
export {
  setProxmoxToolHandlers,
  type ProxmoxRequestResult,
  type ProxmoxToolHandlers,
} from "./extension.js";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { proxmoxTool } from "./extension.js";

const baseDir = dirname(fileURLToPath(import.meta.url));

export default function proxmoxPackagedExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [
      join(baseDir, "skills", "proxmox-guest-compare-chart", "SKILL.md"),
    ],
  }));

  return proxmoxTool(pi);
}
