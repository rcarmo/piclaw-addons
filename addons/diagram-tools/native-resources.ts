/** Declarative proof only. Public resourceLoader owns static registration. */
export const nativeResources = Object.freeze({
  "id": "diagram-tools",
  "version": 1,
  "registration": "public-resource-loader",
  "webEntries": [],
  "skillPaths": [
    "skills/diagram-workflow/SKILL.md",
    "skills/diagram-colour-picker/SKILL.md"
  ],
  "routes": [],
  "settingsActions": []
} as const);
