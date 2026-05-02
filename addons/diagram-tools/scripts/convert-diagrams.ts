#!/usr/bin/env bun
/**
 * Convert hand-crafted SVG diagrams from _content/*.md into JSON graph
 * definitions for diagram-render.ts, then render them.
 *
 * Usage: bun convert-diagrams.ts [project-id ...]
 *        No args = convert all
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { renderDiagram } from "./diagram-render.ts";

const ROOT = process.cwd();
const CONTENT = join(ROOT, "_content");
const OUT = join(ROOT, "_diagrams");
mkdirSync(OUT, { recursive: true });

// Parse an existing SVG and extract nodes + edges
function parseSvg(svg: string): { nodes: any[]; edges: any[]; title: string } {
  const nodes: any[] = [];
  const edges: any[] = [];
  let title = "";

  // Extract all rect + text pairs
  // Pattern: <rect x="N" y="N" width="N" height="N" ... class="box-xxx"/>
  //          <text x="N" y="N" ... class="label">Label</text>
  //          <text x="N" y="N" ... class="sub">Sub</text>

  const rects: { x: number; y: number; w: number; h: number; cls: string }[] = [];
  const rectRe = /<rect\s+x="([^"]+)"\s+y="([^"]+)"\s+width="([^"]+)"\s+height="([^"]+)"[^>]*class="(box[^"]*)"[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = rectRe.exec(svg)) !== null) {
    rects.push({ x: +m[1], y: +m[2], w: +m[3], h: +m[4], cls: m[5] });
  }

  // Extract all text elements with class
  const texts: { x: number; y: number; cls: string; content: string }[] = [];
  const textRe = /<text\s+x="([^"]+)"\s+y="([^"]+)"[^>]*class="(label|sub)"[^>]*>([^<]+)<\/text>/g;
  while ((m = textRe.exec(svg)) !== null) {
    texts.push({ x: +m[1], y: +m[2], cls: m[3], content: m[4].trim() });
  }

  // Match texts to rects (text centre within rect bounds)
  const usedTexts = new Set<number>();
  for (const rect of rects) {
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    // Find label and sub within this rect
    let label = "";
    let sub = "";
    for (let i = 0; i < texts.length; i++) {
      const t = texts[i];
      if (usedTexts.has(i)) continue;
      if (Math.abs(t.x - cx) < rect.w / 2 + 20 && t.y >= rect.y - 5 && t.y <= rect.y + rect.h + 10) {
        if (t.cls === "label") { label = t.content; usedTexts.add(i); }
        else if (t.cls === "sub") { sub = t.content; usedTexts.add(i); }
      }
    }
    if (label) {
      const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
      nodes.push({ id, label, sub, style: rect.cls, _x: rect.x, _y: rect.y, _w: rect.w, _h: rect.h });
    }
  }

  // Assign columns and rows based on x/y positions
  const xPositions = [...new Set(nodes.map((n: any) => n._x))].sort((a, b) => a - b);
  const colMap = new Map(xPositions.map((x, i) => [x, i]));

  for (const n of nodes) {
    n.column = colMap.get(n._x) ?? 0;
  }

  // Within each column, assign rows by y position
  const byCol = new Map<number, any[]>();
  for (const n of nodes) {
    if (!byCol.has(n.column)) byCol.set(n.column, []);
    byCol.get(n.column)!.push(n);
  }
  for (const [, colNodes] of byCol) {
    colNodes.sort((a: any, b: any) => a._y - b._y);
    colNodes.forEach((n: any, i: number) => { n.row = i; });
  }

  // Extract edges from paths/lines
  // Try to match path start/end to node centres
  const pathRe = /<(?:path|line)\s+[^>]*(?:d="M([^"]+)"|x1="([^"]+)"\s+y1="([^"]+)"[^>]*x2="([^"]+)"\s+y2="([^"]+)")[^>]*(?:stroke="([^"]+)")?[^>]*\/>/g;
  while ((m = pathRe.exec(svg)) !== null) {
    let startX: number, startY: number, endX: number, endY: number;
    let color = m[6] || "";

    if (m[1]) {
      // Path: extract first M and last coordinate
      const coords = m[1].match(/[-\d.]+/g)?.map(Number) || [];
      if (coords.length < 4) continue;
      startX = coords[0]; startY = coords[1];
      endX = coords[coords.length - 2]; endY = coords[coords.length - 1];
    } else {
      startX = +m[2]; startY = +m[3]; endX = +m[4]; endY = +m[5];
    }

    // Find closest nodes to start and end
    const fromNode = findClosestNode(nodes, startX, startY);
    const toNode = findClosestNode(nodes, endX, endY);
    if (fromNode && toNode && fromNode.id !== toNode.id) {
      const edge: any = { from: fromNode.id, to: toNode.id };
      if (color === "#3b82f6") edge.accent = true;
      else if (color && color !== "#5070a0") edge.color = color;
      // Deduplicate
      if (!edges.some(e => e.from === edge.from && e.to === edge.to)) {
        edges.push(edge);
      }
    }
  }

  // Find title (last standalone sub text)
  for (let i = 0; i < texts.length; i++) {
    if (!usedTexts.has(i) && texts[i].cls === "sub") {
      title = texts[i].content;
    }
  }

  // Clean up internal props
  for (const n of nodes) {
    delete n._x; delete n._y; delete n._w; delete n._h;
  }

  return { nodes, edges, title };
}

function findClosestNode(nodes: any[], x: number, y: number): any | null {
  let best: any = null;
  let bestDist = Infinity;
  for (const n of nodes) {
    const cx = (n._x ?? 0) + (n._w ?? 180) / 2;
    const cy = (n._y ?? 0) + (n._h ?? 60) / 2;
    const dist = Math.hypot(x - cx, y - cy);
    if (dist < bestDist) { bestDist = dist; best = n; }
  }
  return bestDist < 300 ? best : null;
}

// Extract SVG from markdown
function extractSvg(md: string): string | null {
  const m = md.match(/## Diagram\s*\n(<svg[\s\S]*?<\/svg>)/);
  return m ? m[1] : null;
}

// Main
const args = Bun.argv.slice(2);
const files = args.length
  ? args.map(id => join(CONTENT, `${id}.md`))
  : readdirSync(CONTENT).filter(f => f.endsWith(".md")).map(f => join(CONTENT, f));

let converted = 0;
for (const file of files) {
  const id = basename(file, ".md");
  const md = readFileSync(file, "utf-8");
  const svg = extractSvg(md);
  if (!svg) continue;

  const graph = parseSvg(svg);
  if (!graph.nodes.length) { console.warn(`  ⚠ ${id}: no nodes found`); continue; }

  // Write JSON
  const jsonPath = join(OUT, `${id}.json`);
  writeFileSync(jsonPath, JSON.stringify(graph, null, 2));

  // Render SVG
  const rendered = renderDiagram(graph);
  const svgPath = join(OUT, `${id}.svg`);
  writeFileSync(svgPath, rendered);

  converted++;
  console.log(`  ✓ ${id} (${graph.nodes.length} nodes, ${graph.edges.length} edges)`);
}

console.log(`\nConverted ${converted} diagrams to ${OUT}`);
