# Usage telemetry

Exports local `token_usage` aggregates from a Piclaw instance to Graphite Carbon. It is disabled until a Carbon host is configured. Metrics are instance/provider/model-scoped and the exporter keeps a bounded seven-day/10-MB retry spool.

The bundled `usage-telemetry-chart` skill renders a multi-colour stacked SVG from Graphite. Provider-account polling is intentionally deferred.
