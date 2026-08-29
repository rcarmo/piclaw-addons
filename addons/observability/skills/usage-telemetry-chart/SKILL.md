---
name: usage-telemetry-chart
description: Render a multi-instance Piclaw usage chart from Graphite telemetry.
distribution: public
---

# Usage telemetry chart

Render a seven-day, multi-colour stacked SVG chart from the configured Graphite render endpoint:

```bash
bun ./usage-telemetry-chart.ts --render-url http://graphite:8080 --prefix piclaw.usage
```

Optional filters: `--instance`, `--provider`, `--model`, `--metric tokens.total`, and `--days 7`.

The exporter add-on must be configured and have sent metrics before this chart has data.
