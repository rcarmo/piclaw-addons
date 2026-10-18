import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEditableTableTool } from "./tool.js";
export { createEditableTableTool } from "./tool.js";
export type { EditableTableWidgetPort, EditableTableWidgetOptions } from "./tool.js";
const baseDir = dirname(fileURLToPath(import.meta.url));
export default function editableTableAddon(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => ({ skillPaths: [join(baseDir, "skills", "editable-table", "SKILL.md")] }));
  pi.registerTool(createEditableTableTool());
}
