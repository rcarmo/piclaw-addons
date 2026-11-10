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

For USD API-equivalent known subtotals:

```bash
bun ./usage-telemetry-chart.ts --render-url http://graphite:8080 --metric cost.api_equivalent_usd.known_subtotal
```

Only `tokens.input`, `tokens.output`, `tokens.cache_read`, `tokens.cache_write`, `tokens.reasoning`, `tokens.total` and `cost.api_equivalent_usd.known_subtotal` are additive chart metrics. USD known subtotals may omit unpriced categories; consult the exporter's `complete_rows`, `partial_rows` and `unknown_rows` for coverage. They do not establish a complete provider bill.

Missing observations leave gaps; dots mark supplied zero. The exporter keeps provider totals separate for each explicit currency and retains unlabelled native amounts as individual unknown-unit observations. This chart CLI accepts only the token metrics and USD API-equivalent subtotal listed above; provider-native, legacy and retired ambiguous `cost.estimated_usd` metric names are rejected before any query. Never relabel unknown units or combine different currencies. Existing Graphite history is unchanged.

The exporter add-on must be configured and have sent metrics before this chart has data.
