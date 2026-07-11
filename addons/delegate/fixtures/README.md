# Delegate remediation baseline

Captured: 2026-07-11T18:58:11Z
Repository baseline: `14c8e2c8a1c39cb9dabad87cb7811d43120bc870` on `main`.

These fixtures freeze the behavior observed before the Delegate 0.2.0 remediation:

- `runtime-models-42.json`: the scoped Piclaw runtime registry exposed for `web:addons`.
- `cli-models-29.txt`: the child `pi --list-models` catalog that Delegate can execute through its subprocess.
- `legacy-candidates-26.json`: Delegate 0.1.9 fuzzy candidate assignments, ignored executable models, and models assigned to multiple tiers.

## Pre-existing dirty paths

The following paths were already modified or untracked before remediation and must not be edited, staged, or committed as part of Delegate work:

- `addons/autoresearch/supervisor.ts`
- `addons/imap/global.d.ts`
- `addons/observability/index.ts`
- `addons/plan-sidebar/index.ts`
- `addons/codex-conversion/src/types/`

## Baseline assertions

- Runtime registry: 42 models.
- Child CLI catalog: 29 models.
- Legacy candidate assignments: 26.
- Legacy unique candidate model IDs: 21.
- Legacy multi-tier collisions: 5.
