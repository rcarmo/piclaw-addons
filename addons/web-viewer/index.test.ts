import { expect, test } from "bun:test";

import {
  htmlViewerPaneExtension,
  imageViewerPaneExtension,
  videoViewerPaneExtension,
} from "./web/index.js";

test("web viewers use their standalone pane contract", () => {
  const context = (path: string) => ({ path, mode: "view" as const });
  expect(htmlViewerPaneExtension.canHandle?.(context("index.html"))).toBe(30);
  expect(imageViewerPaneExtension.canHandle?.(context("photo.webp"))).toBe(48);
  expect(videoViewerPaneExtension.canHandle?.(context("clip.mp4"))).toBe(54);
  expect(videoViewerPaneExtension.canHandle?.(context("notes.txt"))).toBeFalse();
});
