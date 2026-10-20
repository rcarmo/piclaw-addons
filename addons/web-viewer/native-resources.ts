/** Declarative proof only. Public resourceLoader owns static registration. */
export const nativeResources = Object.freeze({
  "id": "web-viewer",
  "version": 1,
  "registration": "public-resource-loader",
  "webEntries": [
    "web/index.ts"
  ],
  "skillPaths": [],
  "routes": [
    "/html-viewer",
    "/image-viewer",
    "/video-viewer"
  ],
  "settingsActions": []
} as const);
