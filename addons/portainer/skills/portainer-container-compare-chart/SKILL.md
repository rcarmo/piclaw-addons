---
name: portainer-container-compare-chart
description: Compare two containers using native portainer tool data collection and render SVG/CSV outputs.
distribution: public
---

# Portainer container compare chart

Use this skill when you need a comparative chart for two containers, possibly across different endpoints.

## Goal

Collect data through the native `portainer` tool only, then render comparison artifacts locally.

## Native-tool-first collection flow

1. Ensure Portainer config exists:
   - `action: "discover"`
   - `action: "set"` if needed
2. Resolve endpoints:
   - prefer `action: "workflow", workflow: "endpoint.list"`
   - or `action: "request", method: "GET", path: "/api/endpoints"`
3. Resolve containers on each endpoint:
   - prefer `container.list` / `container.resolve`
   - or raw request to Docker-proxy surfaces like:
     - `/api/endpoints/{id}/docker/containers/json?all=1`
4. Fetch live stats snapshots for each container using native raw request only:
   - `action: "request"`
   - `method: "GET"`
   - `path: "/api/endpoints/{id}/docker/containers/{containerId}/stats"`
   - `query: { "stream": false }`
5. Repeat snapshot collection for a bounded sample window.
6. Write a normalized input JSON file.
7. Run the renderer script in this skill directory.
8. Attach the SVG/CSV/JSON outputs.

## Input schema for the renderer

Write JSON like this before rendering:

```json
{
  "title": "Portainer comparison: graphite vs node-red",
  "subtitle": "12 live samples over ~55s via Portainer Docker stats",
  "items": [
    {
      "endpoint": "diskstation",
      "container": "graphite",
      "image": "graphiteapp/graphite-statsd:latest",
      "samples": [
        {
          "timestamp": "2026-04-05T15:00:00.000Z",
          "cpu_pct": 16.4,
          "mem_pct": 5.6,
          "mem_usage_bytes": 1234,
          "mem_limit_bytes": 5678,
          "rx_bytes": 100,
          "tx_bytes": 200,
          "pids": 42
        }
      ]
    }
  ]
}
```

## Render command

Run the renderer script adjacent to this SKILL file:

```bash
bun ./render-portainer-container-compare.ts \
  --in /workspace/tmp/portainer-compare-input.json \
  --out-prefix /workspace/exports/portainer-compare
```

This writes:
- `/workspace/exports/portainer-compare.svg`
- `/workspace/exports/portainer-compare.csv`
- `/workspace/exports/portainer-compare.json`

## Notes

- Keep data collection in the native `portainer` tool, not direct curl scripts.
- Use raw `request` for stats snapshots and unmodeled Docker-proxy paths.
- The renderer is local-only and intentionally dumb: it consumes normalized JSON and draws the chart.
- Use a bounded sampling window; this is for comparison, not long-lived streaming.
- Use the visual-design defaults: clean, minimal, visible axes, subtle grid, compact legend.
