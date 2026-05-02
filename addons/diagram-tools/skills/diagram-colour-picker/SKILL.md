# Diagram Colour Picker

Interactive widget for adjusting the 11-tag diagram colour palette.

## When to use

When the user wants to visually pick alternative fill/stroke colours for diagram boxes.

## How to use

### 1. Read current colours

Extract the current tag→colour mapping from `scripts/diagram-render.ts`
(the `THEME_CSS` light-mode block — the `.box-*` rules).

### 2. Post the widget

Use `send_dashboard_widget` with the HTML from `colour-picker-widget.html` (sibling of this SKILL.md).

Before posting, update the `tags` array at the top of the `<script>` block with the
current fill/stroke values from the renderer.

```
send_dashboard_widget({
  title: "Diagram Colour Picker",
  content: "Interactive colour picker for diagram tag styles",
  html: <contents of colour-picker-widget.html with current colours>
})
```

### 3. Wait for user submission

The widget sends back a message like:

```
Updated colours:
backend: fill=#74a7ff stroke=#012f7b
processing: fill=#adadad stroke=#000000
```

Only changed colours are included.

### 4. Apply changes

For each changed tag, update the corresponding `.box-*` CSS rule in
`scripts/diagram-render.ts` — both the light-mode default block and the
dark-mode `@media (prefers-color-scheme: dark)` block.

For dark mode, derive darker fill variants from the light fill
(reduce lightness by ~60%, keep hue) and keep strokes vibrant.

### 5. Regenerate all diagrams

```bash
for f in _diagrams/*.json; do
  bun scripts/diagram-render.ts "$f" "_diagrams/$(basename $f .json).svg"
done
```

Then update all `_content/*.md` files and rebuild:

```bash
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
bun run build.ts && bun audit-links.ts
```
