---
name: proxmox-guest-compare-chart
description: Compare two Proxmox guests using native proxmox tool data collection and render SVG/CSV outputs.
distribution: public
---

# Proxmox guest compare chart

Use this skill when you need a comparative chart for two Proxmox guests.

## Goal

Collect data through the native `proxmox` tool only, then render comparison artifacts locally.

## Native-tool-first collection flow

1. Ensure Proxmox config exists:
   - `action: "discover"`
   - `action: "set"` if needed
2. Resolve guests by name with raw request:
   - `action: "request"`
   - `method: "GET"`
   - `path: "/cluster/resources"`
   - `query: { "type": "vm" }`
3. Find the exact guest rows and capture:
   - `name`
   - `type` (`lxc` or `qemu`)
   - `node`
   - `vmid`
   - current summary fields such as `status`, `cpu`, `mem`, `disk`, `maxmem`, `maxdisk`, `uptime`
4. Fetch one RRD series per guest with raw request:
   - `action: "request"`
   - `method: "GET"`
   - `path: "/nodes/{node}/{lxc|qemu}/{vmid}/rrddata"`
   - `query: { "timeframe": "day", "cf": "AVERAGE" }`
5. Write a normalized input JSON file.
6. Run the renderer script in this skill directory.
7. Attach the SVG/CSV/JSON outputs.

## Input schema for the renderer

Write JSON like this before rendering:

```json
{
  "title": "Proxmox comparison: smith vs relay",
  "subtitle": "24h AVERAGE RRD metrics from Proxmox",
  "items": [
    {
      "name": "smith",
      "type": "lxc",
      "node": "tnas",
      "vmid": 103,
      "status": "running",
      "maxmem": 4294967296,
      "mem": 468541440,
      "maxdisk": 137438953472,
      "disk": 5935202304,
      "uptime": 163231,
      "series": [
        { "time": 1743868800, "cpu_pct": 1.2, "mem_pct": 8.4 }
      ]
    }
  ]
}
```

## Render command

Run the renderer script adjacent to this SKILL file:

```bash
bun ./render-proxmox-guest-compare.ts \
  --in /workspace/tmp/proxmox-compare-input.json \
  --out-prefix /workspace/exports/proxmox-compare
```

This writes:
- `/workspace/exports/proxmox-compare.svg`
- `/workspace/exports/proxmox-compare.csv`
- `/workspace/exports/proxmox-compare.json`

## Notes

- Keep data collection in the native `proxmox` tool, not ad-hoc curl scripts.
- The renderer is local-only and intentionally dumb: it consumes normalized JSON and draws the chart.
- Prefer explicit guest names and exact matches from `/cluster/resources`.
- Use the visual-design defaults: clean, minimal, visible axes, subtle grid, compact legend.
