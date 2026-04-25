#!/usr/bin/env bun
/**
 * SCRIPT_JDOC:
 * {
 *   "summary": "Compare portainer container for a packaged skill.",
 *   "aliases": [
 *     "render portainer container compare"
 *   ],
 *   "domains": [
 *     "portainer",
 *     "container"
 *   ],
 *   "verbs": [
 *     "compare"
 *   ],
 *   "nouns": [
 *     "portainer",
 *     "container"
 *   ],
 *   "keywords": [
 *     "portainer",
 *     "container",
 *     "compare",
 *     "chart",
 *     "render"
 *   ],
 *   "guidance": [
 *     "Runnable script entrypoint.",
 *     "Packaged script surface."
 *   ],
 *   "examples": [
 *     "compare portainer container"
 *   ],
 *   "kind": "mixed",
 *   "weight": "standard",
 *   "role": "entrypoint"
 * }
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Sample = {
  timestamp: string;
  cpu_pct: number;
  mem_pct: number;
  mem_usage_bytes?: number;
  mem_limit_bytes?: number;
  rx_bytes?: number;
  tx_bytes?: number;
  pids?: number;
};

type CompareItem = {
  endpoint: string;
  container: string;
  image: string;
  samples: Sample[];
};

type CompareInput = {
  title?: string;
  subtitle?: string;
  items: CompareItem[];
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
}

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
}

function max(nums: number[]): number {
  return nums.length ? Math.max(...nums) : 0;
}

function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function ensureDir(path: string) {
  mkdirSync(dirname(path), { recursive: true });
}

function parseInput(path: string): CompareInput {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CompareInput;
  if (!Array.isArray(parsed.items) || parsed.items.length < 2) {
    throw new Error('Expected at least two comparison items');
  }
  return parsed;
}

function line(samples: Sample[], key: 'cpu_pct' | 'mem_pct', x: number, y: number, w: number, h: number, minT: number, maxT: number): string {
  const norm = samples
    .map((s) => ({ time: new Date(s.timestamp).getTime(), value: Number(s[key]) }))
    .filter((s) => Number.isFinite(s.time) && Number.isFinite(s.value));
  if (!norm.length) return '';
  const xs = (t: number) => x + ((t - minT) / (maxT - minT)) * w;
  const ys = (v: number) => y + h - (Math.max(0, Math.min(100, v)) / 100) * h;
  return norm.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xs(s.time).toFixed(2)} ${ys(s.value).toFixed(2)}`).join(' ');
}

function timeLabel(minT: number, maxT: number, index: number, segments: number): string {
  const t = minT + ((maxT - minT) * index) / segments;
  return new Date(t).toISOString().slice(11, 19);
}

function buildSvg(input: CompareInput): string {
  const items = input.items;
  const width = 1440;
  const height = 980;
  const left = 64;
  const right = 40;
  const cardY = 88;
  const cardH = 126;
  const gap = 20;
  const cardW = (width - left - right - gap) / 2;
  const chartX = left;
  const chartW = width - left - right;
  const chartH = 280;
  const cpuY = cardY + cardH + 44;
  const memY = cpuY + chartH + 78;
  const colors = ['#4f46e5', '#0891b2', '#16a34a', '#dc2626'];
  const times = items.flatMap((item) => item.samples.map((s) => new Date(s.timestamp).getTime()));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || minT === maxT) throw new Error('Not enough time-series data to render');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"/>`;
  svg += `<text x="${left}" y="36" style="font:700 28px system-ui,Segoe UI,sans-serif;fill:#0f172a">${esc(input.title || 'Portainer container comparison')}</text>`;
  svg += `<text x="${left}" y="60" style="font:500 13px system-ui,Segoe UI,sans-serif;fill:#64748b">${esc(input.subtitle || 'Live Docker stats sampled through Portainer')} • generated ${esc(new Date().toISOString())}</text>`;

  items.slice(0, 2).forEach((item, idx) => {
    const x = left + idx * (cardW + gap);
    const current = item.samples[item.samples.length - 1];
    const cpuVals = item.samples.map((s) => s.cpu_pct);
    const memVals = item.samples.map((s) => s.mem_pct);
    svg += `<rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="#ffffff" stroke="#dbe4ee" stroke-width="1"/>`;
    svg += `<text x="${x + 18}" y="${cardY + 28}" style="font:700 20px system-ui,Segoe UI,sans-serif;fill:#0f172a">${esc(item.container)}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 48}" style="font:500 12px system-ui,Segoe UI,sans-serif;fill:#64748b">${esc(item.endpoint)} • ${esc(item.image)}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 74}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">CPU avg ${fmtPct(avg(cpuVals))} • peak ${fmtPct(max(cpuVals))}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 94}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">Memory avg ${fmtPct(avg(memVals))} • now ${fmtPct(current.mem_pct)}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 114}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">Net RX ${fmtBytes(current.rx_bytes || 0)} • TX ${fmtBytes(current.tx_bytes || 0)} • PIDs ${current.pids || 0}</text>`;
  });

  const panel = (title: string, subtitle: string, y: number) => {
    svg += `<text x="${chartX}" y="${y - 18}" style="font:700 18px system-ui,Segoe UI,sans-serif;fill:#0f172a">${esc(title)}</text>`;
    svg += `<text x="${chartX}" y="${y - 2}" style="font:500 12px system-ui,Segoe UI,sans-serif;fill:#64748b">${esc(subtitle)}</text>`;
    svg += `<rect x="${chartX}" y="${y}" width="${chartW}" height="${chartH}" rx="12" fill="#ffffff" stroke="#dbe4ee" stroke-width="1"/>`;
    for (let i = 0; i <= 5; i += 1) {
      const yy = y + chartH - (i * chartH) / 5;
      svg += `<line x1="${chartX}" y1="${yy}" x2="${chartX + chartW}" y2="${yy}" stroke="#e7edf4" stroke-width="1"/>`;
      svg += `<text x="${chartX - 10}" y="${yy + 4}" text-anchor="end" style="font:500 11px system-ui,Segoe UI,sans-serif;fill:#64748b">${i * 20}%</text>`;
    }
    for (let i = 0; i <= 5; i += 1) {
      const xx = chartX + (chartW * i) / 5;
      svg += `<line x1="${xx}" y1="${y}" x2="${xx}" y2="${y + chartH}" stroke="#f0f4f8" stroke-width="1"/>`;
      svg += `<text x="${xx}" y="${y + chartH + 20}" style="font:500 11px system-ui,Segoe UI,sans-serif;fill:#64748b">${timeLabel(minT, maxT, i, 5)}</text>`;
    }
  };

  panel('CPU usage', 'Live Docker stats sampled through Portainer', cpuY);
  panel('Memory usage', 'Container memory as percentage of Docker-reported limit', memY);

  items.slice(0, 2).forEach((item, idx) => {
    svg += `<path d="${line(item.samples, 'cpu_pct', chartX, cpuY, chartW, chartH, minT, maxT)}" fill="none" stroke="${colors[idx]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${line(item.samples, 'mem_pct', chartX, memY, chartW, chartH, minT, maxT)}" fill="none" stroke="${colors[idx]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    const lx = chartX + idx * 170;
    svg += `<line x1="${lx}" y1="${cpuY - 28}" x2="${lx + 22}" y2="${cpuY - 28}" stroke="${colors[idx]}" stroke-width="3.5" stroke-linecap="round"/>`;
    svg += `<text x="${lx + 30}" y="${cpuY - 24}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">${esc(item.container)} @ ${esc(item.endpoint)}</text>`;
    svg += `<line x1="${lx}" y1="${memY - 28}" x2="${lx + 22}" y2="${memY - 28}" stroke="${colors[idx]}" stroke-width="3.5" stroke-linecap="round"/>`;
    svg += `<text x="${lx + 30}" y="${memY - 24}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">${esc(item.container)} @ ${esc(item.endpoint)}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function buildCsv(input: CompareInput): string {
  const rows = [
    'endpoint,container,image,timestamp,cpu_pct,mem_pct,mem_usage_bytes,mem_limit_bytes,rx_bytes,tx_bytes,pids',
    ...input.items.flatMap((item) => item.samples.map((s) => [
      item.endpoint,
      item.container,
      item.image,
      s.timestamp,
      String(s.cpu_pct),
      String(s.mem_pct),
      String(s.mem_usage_bytes || 0),
      String(s.mem_limit_bytes || 0),
      String(s.rx_bytes || 0),
      String(s.tx_bytes || 0),
      String(s.pids || 0),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))),
  ];
  return `${rows.join('\n')}\n`;
}

const inputPath = arg('--in');
const outPrefix = arg('--out-prefix');
if (!inputPath || !outPrefix) {
  throw new Error('Usage: bun render-portainer-container-compare.ts --in <input.json> --out-prefix <prefix>');
}

const input = parseInput(inputPath);
const summary = {
  generated_at: new Date().toISOString(),
  compared: input.items.map((item) => ({
    endpoint: item.endpoint,
    container: item.container,
    image: item.image,
    cpu_avg_pct: Number(avg(item.samples.map((s) => s.cpu_pct)).toFixed(3)),
    cpu_peak_pct: Number(max(item.samples.map((s) => s.cpu_pct)).toFixed(3)),
    mem_avg_pct: Number(avg(item.samples.map((s) => s.mem_pct)).toFixed(3)),
    sample_count: item.samples.length,
  })),
};

const svgPath = `${outPrefix}.svg`;
const csvPath = `${outPrefix}.csv`;
const jsonPath = `${outPrefix}.json`;
ensureDir(svgPath);
writeFileSync(svgPath, buildSvg(input), 'utf8');
writeFileSync(csvPath, buildCsv(input), 'utf8');
writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({ svgPath, csvPath, jsonPath, summary }, null, 2));
