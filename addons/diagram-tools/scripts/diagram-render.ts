#!/usr/bin/env bun
/**
 * diagram-render.ts — Build-time SVG diagram renderer.
 *
 * Input: JSON graph definition (nodes + edges)
 * Output: SVG with auto-layout (left-to-right), orthogonal arrows, dark/light theme
 *
 * Usage: bun diagram-render.ts <input.json> [output.svg]
 *        or import { renderDiagram } from "./diagram-render.ts"
 */

// ── Semantic tag → CSS class mapping ──────────────────────────────────────────

const TAG_STYLES: Record<string, string> = {
  'web':        'box-accent',   // blue — frontends, browsers, UIs
  'backend':    'box-green',    // green — servers, APIs, runtimes
  'state':      'box',          // neutral — databases, stores, config files
  'artifacts':  'box-warm',     // amber — builds, files, models
  'processing': 'box-purple',   // purple — engines, pipelines, transforms
  'scripting':  'box-teal',     // teal — scripting, plugins, extensions
  'infra':      'box-slate',    // slate — containers, VMs, infrastructure
  'external':   'box-indigo',   // indigo — external services, APIs, providers
  'input':      'box-rose',     // rose — user input, sources, triggers
  'output':     'box-orange',   // orange — results, exports, destinations
  'monitor':    'box-cyan',     // cyan — monitoring, logging, observability
};

function resolveStyle(node: { tag?: string; style?: string }): string {
  if (node.style) return node.style;       // explicit override wins
  if (node.tag) return TAG_STYLES[node.tag] || 'box';
  return 'box';
}

// ── Types ────────────────────────────────────────────────────────────────────

interface NodeDef {
  id: string;
  label: string;
  sub?: string;           // subtitle line
  tag?: string;           // semantic tag: web, backend, state, artifacts, processing, scripting, infra, external, input, output, monitor
  style?: string;         // explicit CSS class override (box-accent | box-green | box-warm | box-purple | box-teal | box)
  column?: number;        // explicit column placement (0-based, left-to-right)
  row?: number;           // explicit row within column (0-based, top-to-bottom)
  children?: ChildDef[];  // sub-step nodes rendered below this node in a group
}

interface ChildDef {
  id: string;
  label: string;
  sub?: string;
  tag?: string;
  style?: string;
}

interface EdgeDef {
  from: string;
  to: string;
  label?: string;
  color?: string;         // stroke colour override
  accent?: boolean;       // use accent marker
}

interface GraphDef {
  title?: string;         // subtitle at bottom
  nodes: NodeDef[];
  edges: EdgeDef[];
}

// ── Layout constants ─────────────────────────────────────────────────────────

const COL_WIDTH = 200;
const COL_GAP = 60;
const ROW_HEIGHT = 72;
const ROW_GAP = 16;
const BOX_W = 180;
const BOX_H = 60;
const BOX_RX = 8;
const CHILD_W = 82;       // child box width
const CHILD_H = 48;       // child box height
const CHILD_GAP = 8;      // gap between children
const CHILD_PAD = 8;      // padding inside group container
const PAD_X = 30;
const PAD_Y = 30;
const ARROW_R = 14;       // rounded corner radius for orthogonal bends
const FONT_LABEL = 13;
const FONT_SUB = 11;

// ── Layout engine ────────────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  label: string;
  sub: string;
  style: string;
  col: number;
  row: number;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;            // centre x
  cy: number;            // centre y
  parentX: number;       // inner parent rect x (for arrow routing)
  parentW: number;       // inner parent rect width
  children?: LayoutChild[];
  groupH?: number;       // total height including children group
}

interface LayoutChild {
  id: string;
  label: string;
  sub: string;
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

function layoutNodes(nodes: NodeDef[]): { laid: LayoutNode[]; cols: number; maxY: number } {
  const byCol = new Map<number, NodeDef[]>();
  let autoCol = 0;

  for (const n of nodes) {
    const col = n.column ?? autoCol++;
    if (!byCol.has(col)) byCol.set(col, []);
    byCol.get(col)!.push({ ...n, column: col });
  }

  // Pass 1: compute the widest node in each column
  const colMaxW = new Map<number, number>();
  for (const [col, colNodes] of byCol) {
    let maxW = BOX_W;
    for (const n of colNodes) {
      if (n.children && n.children.length > 0) {
        const totalChildW = n.children.length * CHILD_W + (n.children.length - 1) * CHILD_GAP;
        maxW = Math.max(maxW, totalChildW + CHILD_PAD * 2);
      }
    }
    colMaxW.set(col, maxW);
  }

  // Compute column X positions based on actual widths
  const sortedCols = [...byCol.keys()].sort((a, b) => a - b);
  const colX = new Map<number, number>();
  let curX = PAD_X;
  for (const col of sortedCols) {
    colX.set(col, curX);
    curX += (colMaxW.get(col) || BOX_W) + COL_GAP;
  }

  // Pass 2: layout nodes with proper X positions
  const laid: LayoutNode[] = [];
  let maxCol = 0;
  let maxY = 0;

  for (const [col, colNodes] of byCol) {
    colNodes.sort((a, b) => (a.row ?? 0) - (b.row ?? 0));
    let nextY = PAD_Y;
    const baseX = colX.get(col) || PAD_X;
    const colW = colMaxW.get(col) || BOX_W;

    for (const n of colNodes) {
      const y = n.row !== undefined ? PAD_Y + n.row * (ROW_HEIGHT + ROW_GAP) : nextY;
      const hasChildren = n.children && n.children.length > 0;

      let layoutChildren: LayoutChild[] | undefined;
      let groupH = BOX_H;
      let groupW = BOX_W;

      if (hasChildren) {
        const kids = n.children!;
        const totalChildW = kids.length * CHILD_W + (kids.length - 1) * CHILD_GAP;
        groupW = Math.max(BOX_W, totalChildW + CHILD_PAD * 2);
        const childStartX = baseX + (colW - totalChildW) / 2;
        const childY = y + BOX_H + CHILD_PAD;
        groupH = BOX_H + CHILD_PAD + CHILD_H + CHILD_PAD;

        layoutChildren = kids.map((c, i) => {
          const cx = childStartX + i * (CHILD_W + CHILD_GAP);
          return {
            id: c.id,
            label: c.label,
            sub: c.sub || '',
            style: resolveStyle(c),
            x: cx, y: childY,
            w: CHILD_W, h: CHILD_H,
            cx: cx + CHILD_W / 2,
            cy: childY + CHILD_H / 2,
          };
        });
      }

      // Parent rect centred in column width
      const parentX = baseX + (colW - BOX_W) / 2;

      const node: LayoutNode = {
        id: n.id,
        label: n.label,
        sub: n.sub || '',
        style: resolveStyle(n),
        col, row: n.row ?? 0,
        x: baseX, y,
        w: colW, h: BOX_H,
        cx: baseX + colW / 2,
        cy: y + BOX_H / 2,
        parentX,
        parentW: BOX_W,
        children: layoutChildren,
        groupH,
      };
      laid.push(node);
      nextY = y + groupH + ROW_GAP;
      maxCol = Math.max(maxCol, col);
      maxY = Math.max(maxY, y + groupH);
    }
  }

  return { laid, cols: maxCol + 1, maxY };
}

// ── Orthogonal arrow routing ─────────────────────────────────────────────────

function orthoPath(from: LayoutNode | LayoutChild, to: LayoutNode | LayoutChild, r: number): string {
  const fromCol = 'col' in from ? from.col : -1;
  const toCol = 'col' in to ? to.col : -1;
  const isSameCol = fromCol >= 0 && toCol >= 0 && fromCol === toCol;

  if (isSameCol) {
    // Vertical: straight down (or up)
    const x = from.cx;
    const y1 = from.y + from.h;
    const y2 = to.y;
    return `M${x},${y1} L${x},${y2}`;
  }

  // Horizontal with vertical offset
  // Use inner parent rect bounds for arrow entry/exit
  const fromPX = 'parentX' in from ? (from as LayoutNode).parentX : from.x;
  const fromPW = 'parentW' in from ? (from as LayoutNode).parentW : from.w;
  const toPX = 'parentX' in to ? (to as LayoutNode).parentX : to.x;
  const x1 = fromPX + fromPW;              // right edge of from's inner rect
  const y1 = from.cy;                      // centre of from
  const x2 = toPX;                         // left edge of to's inner rect
  const y2 = to.cy;                        // centre of to

  if (Math.abs(y1 - y2) < 2) {
    // Same height — straight horizontal
    return `M${x1},${y1} L${x2},${y2}`;
  }

  // Midpoint for the vertical segment
  const mx = Math.round((x1 + x2) / 2);
  const dy = y2 > y1 ? 1 : -1;
  const ar = Math.min(r, Math.abs(y2 - y1) / 2, Math.abs(mx - x1) / 2);

  // Path: right → bend → down/up → bend → right
  return [
    `M${x1},${y1}`,
    `L${mx - ar},${y1}`,
    `Q${mx},${y1} ${mx},${y1 + dy * ar}`,
    `L${mx},${y2 - dy * ar}`,
    `Q${mx},${y2} ${mx + ar},${y2}`,
    `L${x2},${y2}`,
  ].join(' ');
}

// ── SVG rendering ────────────────────────────────────────────────────────────

const THEME_CSS = `
    /* Default: light mode (for rsvg-convert and non-media-query agents) */
    .bg { fill: transparent; }
    .box { fill: #ffffff; stroke: #707070; stroke-width: 1.5; }
    .box-accent { fill: #dbeafe; stroke: #3b82f6; stroke-width: 1.5; }
    .box-green { fill: #74a7ff; stroke: #012f7b; stroke-width: 1.5; }
    .box-warm { fill: #fef3c7; stroke: #d97706; stroke-width: 1.5; }
    .box-purple { fill: #adadad; stroke: #000000; stroke-width: 1.5; }
    .box-teal { fill: #ebebeb; stroke: #474747; stroke-width: 1.5; }
    .box-slate { fill: #a7c6ff; stroke: #0042a9; stroke-width: 1.5; }
    .box-indigo { fill: #dfeed4; stroke: #4e7a27; stroke-width: 1.5; }
    .box-rose { fill: #dfeed4; stroke: #76bb40; stroke-width: 1.5; }
    .box-orange { fill: #ffedd5; stroke: #ea580c; stroke-width: 1.5; }
    .box-cyan { fill: #d9c9fe; stroke: #5e30eb; stroke-width: 1.5; }
    .label { fill: #1a2a40; }
    .sub { fill: #5070a0; }
    text { font-family: -apple-system, "Segoe UI", Helvetica, sans-serif; }
    .label { font-size: ${FONT_LABEL}px; font-weight: 600; }
    .sub { font-size: ${FONT_SUB}px; }
    @media (prefers-color-scheme: dark) {
      .bg { fill: transparent; }
      .box { fill: #1a1e2a; stroke: #505050; }
      .box-accent { fill: #0d1e38; stroke: #2b5cb0; }
      .box-green { fill: #0a1a3a; stroke: #4a80d0; }
      .box-warm { fill: #221a10; stroke: #a06020; }
      .box-purple { fill: #222222; stroke: #666666; }
      .box-teal { fill: #1e1e1e; stroke: #666666; }
      .box-slate { fill: #0d1a38; stroke: #4a7ad0; }
      .box-indigo { fill: #1a2810; stroke: #5a8a30; }
      .box-rose { fill: #1a2810; stroke: #5aaa30; }
      .box-orange { fill: #2a1a08; stroke: #f97316; }
      .box-cyan { fill: #1a1030; stroke: #7040d0; }
      .label { fill: #d0daf0; }
      .sub { fill: #5070a0; }
    }`;

export function renderDiagram(graph: GraphDef): string {
  const { laid, cols, maxY } = layoutNodes(graph.nodes);
  // Build node map including children
  const nodeMap = new Map<string, LayoutNode | LayoutChild>();
  for (const n of laid) {
    nodeMap.set(n.id, n);
    if (n.children) for (const c of n.children) nodeMap.set(c.id, c);
  }

  // Compute total width accounting for nodes wider than COL_WIDTH
  let maxRight = 0;
  for (const n of laid) {
    maxRight = Math.max(maxRight, n.x + n.w);
  }
  const totalW = maxRight + PAD_X;
  const totalH = maxY + (graph.title ? 24 : 10);

  // Nodes SVG
  const nodesSvg = laid.map(n => {
    const labelY = n.sub ? n.y + n.h / 2 - 4 : n.y + n.h / 2 + 4;
    const subY = n.y + n.h / 2 + 14;
    // If node has children, centre the parent rect within the column
    const hasKids = n.children && n.children.length > 0;
    const parts = [
      `  <rect x="${n.parentX}" y="${n.y}" width="${n.parentW}" height="${n.h}" rx="${BOX_RX}" class="${n.style}"/>`,
      `  <text x="${n.cx}" y="${labelY}" text-anchor="middle" class="label">${esc(n.label)}</text>`,
      n.sub ? `  <text x="${n.cx}" y="${subY}" text-anchor="middle" class="sub">${esc(n.sub)}</text>` : '',
    ];

    // Render children group
    if (n.children && n.children.length) {
      // Dashed group container around parent + children
      const gx = n.x - CHILD_PAD;
      const gy = n.y - CHILD_PAD;
      const gw = n.w + CHILD_PAD * 2;
      const gh = (n.groupH || n.h) + CHILD_PAD * 2;
      parts.unshift(`  <rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="12" fill="none" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3" opacity="0.5"/>`);

      for (const c of n.children) {
        const cLabelY = c.sub ? c.y + c.h / 2 - 3 : c.y + c.h / 2 + 4;
        const cSubY = c.y + c.h / 2 + 11;
        parts.push(
          `  <rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="6" class="${c.style}"/>`,
          `  <text x="${c.cx}" y="${cLabelY}" text-anchor="middle" class="label" style="font-size:11px">${esc(c.label)}</text>`,
          c.sub ? `  <text x="${c.cx}" y="${cSubY}" text-anchor="middle" class="sub" style="font-size:9px">${esc(c.sub)}</text>` : '',
        );
      }
    }

    return parts.filter(Boolean).join('\n');
  }).join('\n\n');

  // Edges SVG
  const edgesSvg = graph.edges.map(e => {
    const from = nodeMap.get(e.from);
    const to = nodeMap.get(e.to);
    if (!from || !to) return `<!-- missing: ${e.from} → ${e.to} -->`;

    const color = e.color || (e.accent ? '#3b82f6' : '#5070a0');
    const markerId = e.accent ? 'ahs' : 'ah';
    const d = orthoPath(from, to, ARROW_R);
    let svg = `  <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" marker-end="url(#${markerId})"/>`;

    if (e.label) {
      // Place label on the horizontal segment, just above the line
      const fromCol = 'col' in from ? (from as LayoutNode).col : -1;
      const toCol = 'col' in to ? (to as LayoutNode).col : -1;
      const sameCol = fromCol >= 0 && toCol >= 0 && fromCol === toCol;
      let lx: number, ly: number;
      if (sameCol) {
        // Vertical arrow: label to the right of midpoint
        lx = from.cx + 12;
        ly = Math.round((from.y + from.h + to.y) / 2) + 4;
        svg += `\n  <text x="${lx}" y="${ly}" class="sub">${esc(e.label)}</text>`;
      } else {
        // Horizontal arrow: label centred on the horizontal run, just above
        lx = Math.round(((('parentX' in from ? (from as LayoutNode).parentX : from.x) + (('parentW' in from ? (from as LayoutNode).parentW : from.w))) + ('parentX' in to ? (to as LayoutNode).parentX : to.x)) / 2);
        ly = Math.round(Math.min(from.cy, to.cy)) - 6;
        svg += `\n  <text x="${lx}" y="${ly}" text-anchor="middle" class="sub">${esc(e.label)}</text>`;
      }
    }
    return svg;
  }).join('\n');

  // Title
  const titleSvg = graph.title
    ? `  <text x="${totalW / 2}" y="${totalH - 4}" text-anchor="middle" class="sub">${esc(graph.title)}</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}">
  <style>${THEME_CSS}
  </style>
  <defs>
    <marker id="ah" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8z" fill="#5070a0" stroke="none"/>
    </marker>
    <marker id="ahs" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8z" fill="#3b82f6" stroke="none"/>
    </marker>
  </defs>
  <rect width="${totalW}" height="${totalH}" class="bg" rx="8"/>

${nodesSvg}

${edgesSvg}

${titleSvg}
</svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [input, output] = Bun.argv.slice(2);
  if (!input) {
    console.log("Usage: bun diagram-render.ts <input.json> [output.svg]");
    process.exit(1);
  }
  const graph: GraphDef = await Bun.file(input).json();
  const svg = renderDiagram(graph);
  if (output) {
    await Bun.write(output, svg);
    console.log(`Wrote ${output}`);
  } else {
    console.log(svg);
  }
}
