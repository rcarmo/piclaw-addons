#!/usr/bin/env bun
/**
 * SCRIPT_JDOC:
 * {
 *   "summary": "Compare guest for a packaged skill.",
 *   "aliases": [
 *     "render proxmox guest compare"
 *   ],
 *   "domains": [
 *     "proxmox"
 *   ],
 *   "verbs": [
 *     "compare"
 *   ],
 *   "nouns": [
 *     "guest"
 *   ],
 *   "keywords": [
 *     "proxmox",
 *     "guest",
 *     "compare",
 *     "chart",
 *     "render"
 *   ],
 *   "guidance": [
 *     "Runnable script entrypoint.",
 *     "Packaged script surface."
 *   ],
 *   "examples": [
 *     "compare guest"
 *   ],
 *   "kind": "mixed",
 *   "weight": "standard",
 *   "role": "entrypoint"
 * }
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type SeriesPoint = {
  time: number;
  cpu_pct?: number | null;
  mem_pct?: number | null;
};

type CompareItem = {
  name: string;
  type: 'lxc' | 'qemu';
  node: string;
  vmid: number;
  status?: string;
  maxmem?: number;
  mem?: number;
  maxdisk?: number;
  disk?: number;
  uptime?: number;
  series: SeriesPoint[];
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

function fmtUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
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

function line(points: SeriesPoint[], key: 'cpu_pct' | 'mem_pct', x: number, y: number, w: number, h: number, minT: number, maxT: number): string {
  const valid = points.filter((p) => typeof p[key] === 'number' && Number.isFinite(p[key] as number));
  if (!valid.length) return '';
  const xs = (t: number) => x + ((t - minT) / (maxT - minT)) * w;
  const ys = (v: number) => y + h - (Math.max(0, Math.min(100, v)) / 100) * h;
  return valid.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs(p.time).toFixed(2)} ${ys(p[key] as number).toFixed(2)}`).join(' ');
}

function timeLabel(minT: number, maxT: number, index: number, segments: number): string {
  const t = minT + ((maxT - minT) * index) / segments;
  return new Date(t * 1000).toISOString().slice(11, 16);
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
  const times = items.flatMap((item) => item.series.map((p) => p.time));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  if (!Number.isFinite(minT) || !Number.isFinite(maxT) || minT === maxT) throw new Error('Not enough time-series data to render');

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  svg += `<rect x="0" y="0" width="${width}" height="${height}" fill="#f8fafc"/>`;
  svg += `<text x="${left}" y="36" style="font:700 28px system-ui,Segoe UI,sans-serif;fill:#0f172a">${esc(input.title || 'Proxmox guest comparison')}</text>`;
  svg += `<text x="${left}" y="60" style="font:500 13px system-ui,Segoe UI,sans-serif;fill:#64748b">${esc(input.subtitle || '24h AVERAGE RRD metrics from Proxmox')} • generated ${esc(new Date().toISOString())}</text>`;

  items.slice(0, 2).forEach((item, idx) => {
    const x = left + idx * (cardW + gap);
    const cpuVals = item.series.map((p) => p.cpu_pct).filter((v): v is number => typeof v === 'number');
    const memVals = item.series.map((p) => p.mem_pct).filter((v): v is number => typeof v === 'number');
    const diskPct = item.maxdisk && item.maxdisk > 0 && item.disk ? (item.disk / item.maxdisk) * 100 : 0;
    svg += `<rect x="${x}" y="${cardY}" width="${cardW}" height="${cardH}" rx="14" fill="#ffffff" stroke="#dbe4ee" stroke-width="1"/>`;
    svg += `<text x="${x + 18}" y="${cardY + 28}" style="font:700 20px system-ui,Segoe UI,sans-serif;fill:#0f172a">${esc(item.name)}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 48}" style="font:500 12px system-ui,Segoe UI,sans-serif;fill:#64748b">${esc(item.type.toUpperCase())} ${item.vmid} on ${esc(item.node)}${item.status ? ` • ${esc(item.status)}` : ''}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 74}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">CPU avg ${fmtPct(avg(cpuVals))} • peak ${fmtPct(max(cpuVals))}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 94}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">Memory avg ${fmtPct(avg(memVals))}${item.maxmem && item.mem ? ` • now ${fmtPct((item.mem / item.maxmem) * 100)}` : ''}</text>`;
    svg += `<text x="${x + 18}" y="${cardY + 114}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">Disk ${fmtBytes(item.disk || 0)} / ${fmtBytes(item.maxdisk || 0)} (${fmtPct(diskPct)}) • uptime ${fmtUptime(item.uptime || 0)}</text>`;
    svg += `<rect x="${x + cardW - 190}" y="${cardY + 20}" width="150" height="10" rx="5" fill="#edf2f7"/>`;
    svg += `<rect x="${x + cardW - 190}" y="${cardY + 20}" width="${Math.max(2, 150 * Math.min(1, diskPct / 100))}" height="10" rx="5" fill="${colors[idx]}" opacity="0.85"/>`;
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
    for (let i = 0; i <= 6; i += 1) {
      const xx = chartX + (chartW * i) / 6;
      svg += `<line x1="${xx}" y1="${y}" x2="${xx}" y2="${y + chartH}" stroke="#f0f4f8" stroke-width="1"/>`;
      if (i < 6) svg += `<text x="${xx}" y="${y + chartH + 20}" style="font:500 11px system-ui,Segoe UI,sans-serif;fill:#64748b">${timeLabel(minT, maxT, i, 6)}</text>`;
    }
  };

  panel('CPU usage', 'AVERAGE RRD series over time', cpuY);
  panel('Memory usage', 'Memory as percentage of configured max memory', memY);

  items.slice(0, 2).forEach((item, idx) => {
    svg += `<path d="${line(item.series, 'cpu_pct', chartX, cpuY, chartW, chartH, minT, maxT)}" fill="none" stroke="${colors[idx]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    svg += `<path d="${line(item.series, 'mem_pct', chartX, memY, chartW, chartH, minT, maxT)}" fill="none" stroke="${colors[idx]}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
    const lx = chartX + idx * 170;
    svg += `<line x1="${lx}" y1="${cpuY - 28}" x2="${lx + 22}" y2="${cpuY - 28}" stroke="${colors[idx]}" stroke-width="3.5" stroke-linecap="round"/>`;
    svg += `<text x="${lx + 30}" y="${cpuY - 24}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">${esc(item.name)} @ ${esc(item.node)}</text>`;
    svg += `<line x1="${lx}" y1="${memY - 28}" x2="${lx + 22}" y2="${memY - 28}" stroke="${colors[idx]}" stroke-width="3.5" stroke-linecap="round"/>`;
    svg += `<text x="${lx + 30}" y="${memY - 24}" style="font:600 12px system-ui,Segoe UI,sans-serif;fill:#334155">${esc(item.name)} @ ${esc(item.node)}</text>`;
  });

  svg += `</svg>`;
  return svg;
}

function buildCsv(input: CompareInput): string {
  const rows = [
    'name,node,type,vmid,status,time_iso,cpu_pct,mem_pct',
    ...input.items.flatMap((item) => item.series.map((p) => [
      item.name,
      item.node,
      item.type,
      String(item.vmid),
      item.status || '',
      new Date(p.time * 1000).toISOString(),
      p.cpu_pct == null ? '' : String(p.cpu_pct),
      p.mem_pct == null ? '' : String(p.mem_pct),
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))),
  ];
  return `${rows.join('\n')}\n`;
}

const inputPath = arg('--in');
const outPrefix = arg('--out-prefix');
if (!inputPath || !outPrefix) {
  throw new Error('Usage: bun render-proxmox-guest-compare.ts --in <input.json> --out-prefix <prefix>');
}

const input = parseInput(inputPath);
const summary = {
  generated_at: new Date().toISOString(),
  compared: input.items.map((item) => {
    const cpuVals = item.series.map((p) => p.cpu_pct).filter((v): v is number => typeof v === 'number');
    const memVals = item.series.map((p) => p.mem_pct).filter((v): v is number => typeof v === 'number');
    return {
      name: item.name,
      node: item.node,
      vmid: item.vmid,
      type: item.type,
      cpu_avg_pct: Number(avg(cpuVals).toFixed(3)),
      cpu_peak_pct: Number(max(cpuVals).toFixed(3)),
      mem_avg_pct: Number(avg(memVals).toFixed(3)),
      points: item.series.length,
    };
  }),
};

const svgPath = `${outPrefix}.svg`;
const csvPath = `${outPrefix}.csv`;
const jsonPath = `${outPrefix}.json`;
ensureDir(svgPath);
writeFileSync(svgPath, buildSvg(input), 'utf8');
writeFileSync(csvPath, buildCsv(input), 'utf8');
writeFileSync(jsonPath, JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({ svgPath, csvPath, jsonPath, summary }, null, 2));
