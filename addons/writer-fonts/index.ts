/**
 * writer-fonts — runtime entry.
 *
 * All behavior lives in the web entry (`web/index.ts`), which injects a font
 * picker into the document editor footer and live-switches the CodeMirror font
 * between bundled writing faces. This runtime extension is intentionally inert;
 * it exists so the package is a well-formed piclaw extension and shows up in the
 * installed add-on list. No tools, events, or config are registered.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function writerFontsAddon(_pi: ExtensionAPI): void {
  // No-op: the web layer (pi.web.entries) provides the editor font picker.
}
