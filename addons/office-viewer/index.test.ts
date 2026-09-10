import { expect, test } from "bun:test";

import { officeViewerPaneExtension } from "./web/office-viewer-pane.js";

test("office viewer uses its standalone pane contract", () => {
  expect(officeViewerPaneExtension.canHandle?.({ path: "report.docx", mode: "view" })).toBe(50);
  expect(officeViewerPaneExtension.canHandle?.({ path: "report.pdf", mode: "view" })).toBeFalse();
  expect(officeViewerPaneExtension.capabilities).toEqual(["readonly", "preview"]);
});
