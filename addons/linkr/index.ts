import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import extension from "./extension.js";
export const skillNames = [
  "linkr-control",
  "linkr-reboot-bios",
  "linkr-firmware-navigation",
  "linkr-boot-selection",
  "linkr-os-install",
  "linkr-recovery",
  "linkr-qualify-device",
];
export default function linkr(pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: skillNames.map((name) =>
      join(import.meta.dir, "skills", name, "SKILL.md"),
    ),
  }));
  extension(pi);
}
