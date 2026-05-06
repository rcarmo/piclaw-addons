/**
 * web/index.ts — Browser-side pane registrations for @rcarmo/piclaw-addon-office-viewer.
 *
 * Registers:
 * - officeViewerPaneExtension  (.docx, .xlsx, .pptx, .odt, .ods, .odp)
 * - pdfViewerPaneExtension     (.pdf, browser-native rendering)
 *
 * Each module self-registers via globalThis.__piclaw_web.registerPane on load.
 */
import './office-viewer-pane.ts';
import './pdf-viewer-pane.ts';
