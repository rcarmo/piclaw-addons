/** Declarative proof only. Public resourceLoader owns static registration. */
export const nativeResources = Object.freeze({
  "id": "kanban-editor",
  "version": 1,
  "registration": "public-resource-loader",
  "webEntries": [
    "web/index.ts"
  ],
  "skillPaths": [],
  "routes": [],
  "settingsActions": []
} as const);
