# diagram-tools

Architecture diagram workflow for the portfolio site — JSON graph definitions → SVG rendering → colour palette management.

## What's included

| Skill | Description |
|---|---|
| `diagram-workflow` | End-to-end: define a graph in JSON, render SVG, inject into markdown, rebuild |
| `diagram-colour-picker` | Interactive widget for adjusting the 11-tag colour palette |

## Scripts

| Script | Description |
|---|---|
| `diagram-render.ts` | Build-time SVG layout engine (import or CLI) |
| `convert-diagrams.ts` | Batch-convert hand-crafted SVG diagrams to JSON definitions |

## Graph JSON spec

```json
{
  "title": "Caption text below the diagram",
  "nodes": [
    {
      "id": "unique-id",
      "label": "Display name",
      "sub": "Subtitle line",
      "tag": "web|backend|state|artifacts|processing|scripting|infra|external|input|output|monitor",
      "column": 0,
      "row": 0,
      "children": [
        { "id": "child-id", "label": "Child", "sub": "detail", "tag": "scripting" }
      ]
    }
  ],
  "edges": [
    { "from": "source-id", "to": "target-id", "label": "optional", "accent": true }
  ]
}
```

## Semantic tags

| Tag | Colour | Use for |
|---|---|---|
| `web` | blue | frontends, browsers, UIs |
| `backend` | blue | servers, APIs, runtimes |
| `state` | grey | databases, stores, config |
| `artifacts` | amber | builds, files, models |
| `processing` | dark grey | engines, pipelines, transforms |
| `scripting` | light grey | scripting, plugins, extensions |
| `infra` | blue | containers, VMs, infrastructure |
| `external` | green | external services, APIs |
| `input` | green | user input, sources, triggers |
| `output` | orange | results, exports, destinations |
| `monitor` | purple | monitoring, logging, observability |
