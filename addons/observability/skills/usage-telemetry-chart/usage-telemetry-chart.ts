import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";

const args = parseArgs({ options: { "render-url": { type: "string" }, prefix: { type: "string", default: "piclaw.usage" }, metric: { type: "string", default: "tokens.total" }, days: { type: "string", default: "7" }, instance: { type: "string" }, provider: { type: "string" }, model: { type: "string" }, output: { type: "string" } } }).values;
if (!args["render-url"]) throw new Error("--render-url is required");
const days = Math.max(1, Math.min(90, Number(args.days) || 7));
const prefix = args.prefix!;
const target = `${prefix}.*.*.*.${args.metric}`;
const url = new URL("render", args["render-url"]!.endsWith("/") ? args["render-url"] : `${args["render-url"]}/`);
url.searchParams.set("target", target); url.searchParams.set("from", `-${days}days`); url.searchParams.set("format", "json");
const response = await fetch(url); if (!response.ok) throw new Error(`Graphite returned ${response.status}`);
const series = await response.json() as Array<{ target: string; datapoints: Array<[number | null, number]> }>;
const filter = (target: string) => {
  const segments = target.split("."); const base = prefix.split(".").length;
  return (!args.instance || segments[base] === args.instance) && (!args.provider || segments[base + 1] === args.provider) && (!args.model || segments[base + 2] === args.model);
};
const byInstance = new Map<string, Map<string, number>>();
for (const item of series.filter(item => filter(item.target))) {
  const instance = item.target.split(".")[prefix.split(".").length] || "unknown"; const data = byInstance.get(instance) || new Map<string, number>(); byInstance.set(instance, data);
  for (const [value, epoch] of item.datapoints) { if (value == null) continue; const day = new Date(epoch * 1000).toISOString().slice(0, 10); data.set(day, (data.get(day) || 0) + value); }
}
const allDays = Array.from({ length: days }, (_, i) => new Date(Date.now() - (days - i - 1) * 864e5).toISOString().slice(0, 10));
const max = Math.max(1, ...allDays.map(day => [...byInstance.values()].reduce((sum, values) => sum + (values.get(day) || 0), 0)));
const colors = ["#38bdf8", "#34d399", "#fbbf24", "#fb7185", "#a78bfa", "#22c55e"];
const width = 960, height = 420, left = 64, top = 34, plotW = 860, plotH = 290, barW = Math.max(5, plotW / days - 10);
const instances = [...byInstance.keys()].sort();
const bars = allDays.map((day, index) => { let y = top + plotH; const x = left + index * plotW / days + (plotW / days - barW) / 2; return instances.map((name, colorIndex) => { const value = byInstance.get(name)?.get(day) || 0; const h = value / max * plotH; y -= h; return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${colors[colorIndex % colors.length]}"/>`; }).join(""); }).join("");
const legend = instances.map((name, i) => `<g transform="translate(${left + i * 145},${height - 36})"><rect width="10" height="10" fill="${colors[i % colors.length]}"/><text x="15" y="10">${name}</text></g>`).join("");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><style>text{font:12px system-ui,sans-serif;fill:#94a3b8}.title{font-size:16px;fill:#e2e8f0;font-weight:600}.axis{stroke:#475569;stroke-width:1}</style><rect width="100%" height="100%" fill="#0f172a" rx="10"/><text class="title" x="${left}" y="22">Piclaw usage · ${args.metric} · ${days} days</text><line class="axis" x1="${left}" y1="${top + plotH}" x2="${left + plotW}" y2="${top + plotH}"/><text x="8" y="${top + 8}">${Math.round(max).toLocaleString()}</text><text x="8" y="${top + plotH}">0</text>${bars}${allDays.map((day,i) => i % Math.ceil(days / 7) === 0 ? `<text x="${left + i * plotW / days}" y="${top + plotH + 18}">${day.slice(5)}</text>` : "").join("")}${legend}</svg>`;
if (args.output) writeFileSync(args.output, svg); else process.stdout.write(svg);
