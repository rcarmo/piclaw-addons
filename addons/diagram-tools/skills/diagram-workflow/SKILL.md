# Diagram Workflow

End-to-end architecture diagram pipeline: define a JSON graph → render SVG → inject into project markdown → rebuild site.

## When to use

When creating or updating architecture diagrams for portfolio project pages.

## Prerequisites

- `bun` runtime
- `rsvg-convert` (for PNG previews, optional)
- The scripts in this addon's `scripts/` directory

## Graph JSON spec

Each diagram is a JSON file in `_diagrams/{project-id}.json`:

```json
{
  "title": "Caption below the diagram",
  "nodes": [
    {
      "id": "unique-id",
      "label": "Box label",
      "sub": "Subtitle text",
      "tag": "web",
      "column": 0,
      "row": 0,
      "children": [
        { "id": "child", "label": "Child box", "sub": "detail", "tag": "scripting" }
      ]
    }
  ],
  "edges": [
    { "from": "source-id", "to": "target-id", "label": "optional annotation", "accent": true }
  ]
}
```

### Semantic tags

| Tag | Use for |
|---|---|
| `web` | frontends, browsers, UIs |
| `backend` | servers, APIs, runtimes |
| `state` | databases, stores, config |
| `artifacts` | builds, files, models |
| `processing` | engines, pipelines, transforms |
| `scripting` | scripting, plugins, extensions |
| `infra` | containers, VMs, infrastructure |
| `external` | external services, APIs, providers |
| `input` | user input, sources, triggers |
| `output` | results, exports, destinations |
| `monitor` | monitoring, logging, observability |

Tags control box colours consistently across all diagrams. Use `"style": "box-accent"` to override.

### Layout rules

- `column` (0-based, left-to-right) and `row` (0-based, top-to-bottom) control placement
- Nodes with `children` get a dashed group container; children render as smaller boxes below the parent
- Column width auto-expands when children are wider than `BOX_W`
- Arrows are orthogonal with rounded corners (r=14), routed to the inner parent rect

### Edge guidelines

- Be sparing with labels — only annotate when the relationship isn't obvious
- Use `"accent": true` for the primary data flow path
- Use `"color": "#hex"` for custom arrow colours

## Workflow

### 1. Create or edit the JSON definition

```bash
# New diagram
cat > _diagrams/my-project.json << 'EOF'
{ "title": "...", "nodes": [...], "edges": [...] }
EOF
```

### 2. Render SVG

```bash
bun scripts/diagram-render.ts _diagrams/my-project.json _diagrams/my-project.svg
```

### 3. Inject into markdown

The `## Diagram` section in `_content/my-project.md` should contain the raw SVG.
Replace it with the rendered output:

```python
# Or use convert-diagrams.ts for batch:
bun scripts/convert-diagrams.ts my-project
```

Or manually:
```bash
python3 -c "
import re
md = open('_content/my-project.md').read()
svg = open('_diagrams/my-project.svg').read()
md = re.sub(r'(## Diagram\s*\n)<svg[\s\S]*?</svg>', r'\1' + svg, md)
open('_content/my-project.md', 'w').write(md)
"
```

### 4. Build and verify

```bash
bun run build.ts
bun audit-links.ts
```

### 5. Preview as PNG (optional)

```bash
rsvg-convert -w 900 -o /tmp/preview.png _diagrams/my-project.svg
```

## Batch operations

### Regenerate all diagrams after a renderer or palette change

```bash
for f in _diagrams/*.json; do
  bun scripts/diagram-render.ts "$f" "_diagrams/$(basename $f .json).svg"
done

# Then update all markdown files
python3 -c "
import re, os, glob
for md in sorted(glob.glob('_content/*.md')):
    name = os.path.basename(md).replace('.md','')
    svg_f = f'_diagrams/{name}.svg'
    if not os.path.exists(svg_f): continue
    content = open(md).read()
    svg = open(svg_f).read()
    content = re.sub(r'(## Diagram\s*\n)<svg[\s\S]*?</svg>', r'\1' + svg, content)
    open(md, 'w').write(content)
"
```

### Convert existing hand-crafted SVGs to JSON

```bash
bun scripts/convert-diagrams.ts           # all projects
bun scripts/convert-diagrams.ts piku gi   # specific projects
```

This parses rect+text elements from the existing SVG, groups them into nodes, extracts edges from paths, and auto-assigns semantic tags based on label keywords.
