export { bindNativeSessionDashboard as createNativeSessionDashboard } from "./index.ts";
/** Declarative proof only. Public resourceLoader owns static registration. */
export const nativeResources = Object.freeze({
  "id": "session-dashboard",
  "version": 1,
  "factoryExport": "createNativeSessionDashboard",
  "registration": "public-resource-loader",
  "webEntries": [
    "web/index.ts"
  ],
  "skillPaths": [],
  "routes": [],
  "settingsActions": [
    "sessions"
  ]
} as const);
