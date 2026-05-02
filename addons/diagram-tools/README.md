# diagram-tools

Architecture diagram workflow for the portfolio site — JSON graph definitions → SVG rendering → colour palette management.

## How it works

![diagram-tools workflow](assets/workflow.svg)

1. Define a compact graph JSON file with nodes, semantic tags, and edges.
2. Use the `diagram-workflow` skill and `diagram-render.ts` tooling to render a themed SVG with orthogonal rounded arrows.
3. Embed the SVG in Markdown and rebuild/publish the generated site page.

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
