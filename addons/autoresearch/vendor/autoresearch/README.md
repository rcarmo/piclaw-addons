# Vendored: pi-autoresearch

Autonomous experiment loop extension and skill for [pi](https://github.com/mariozechner/pi-coding-agent).

**Authors:** Tobi Lutke and David Cortés
**Repository:** [github.com/davebcn87/pi-autoresearch](https://github.com/davebcn87/pi-autoresearch)
**License:** MIT

## Why vendored

Piclaw runs pi-autoresearch as a headless sub-agent in a tmux session,
supervised by piclaw's `autoresearch-supervisor` extension. The files are
vendored unmodified so the sub-agent can load them without requiring a
separate `pi install` step.

## Contents

- `extensions/pi-autoresearch/index.ts` — tools (`init_experiment`, `run_experiment`, `log_experiment`), TUI dashboard, JSONL persistence
- `skills/autoresearch-create/SKILL.md` — setup skill that gathers goal/metric/scope and starts the loop
- `LICENSE` — MIT (Tobi Lutke, David Cortés)

## Upstream sync

To update, copy fresh files from the upstream repo:

```bash
cd /workspace/tmp && git clone https://github.com/davebcn87/pi-autoresearch.git
cp pi-autoresearch/extensions/pi-autoresearch/index.ts /workspace/piclaw-addons/addons/autoresearch/vendor/autoresearch/extensions/pi-autoresearch/
cp pi-autoresearch/skills/autoresearch-create/SKILL.md /workspace/piclaw-addons/addons/autoresearch/vendor/autoresearch/skills/autoresearch-create/
cp pi-autoresearch/LICENSE /workspace/piclaw-addons/addons/autoresearch/vendor/autoresearch/
```
