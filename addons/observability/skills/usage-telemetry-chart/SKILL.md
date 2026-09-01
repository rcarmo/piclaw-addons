---
name: usage-telemetry-chart
description: Render a multi-instance Piclaw usage chart from Graphite telemetry.
distribution: public
---

# Usage telemetry chart

Render a seven-day, multi-colour stacked SVG chart from the configured Graphite render endpoint:

```bash
bun ./usage-telemetry-chart.ts --render-url http://graphite:8080 --prefix piclaw
```

`--prefix` is the Graphite root before the instance segment and defaults to `piclaw`. Optional filters: `--instance`, `--provider`, `--model`, `--metric tokens.total`, and `--days 7`.

The chart reads instance-first paths such as `piclaw.smith.usage.github-copilot.gpt_5_6_sol.tokens.total`. It does not query the pre-0.1.14 `piclaw.usage.<instance>...` namespace.

The exporter add-on must be configured and have sent metrics before this chart has data.
