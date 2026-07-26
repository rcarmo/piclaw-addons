# Autoresearch Supervisor

Runs an autonomous `pi-autoresearch` sub-agent in tmux. Requires Piclaw `>=1.8.0`, plus `pi`, `tmux`, and Git on `PATH`.

## Install

Open **Settings → Add-Ons** and install **autoresearch** from the catalog.

## Tools

### `start_autoresearch`

Required fields:

- `project_dir` — project directory under the workspace
- `prompt` — experiment objective

Optional fields include `model`, `max_iterations`, `sandbox`, and template variables. `sandbox` defaults to true. If false, the supervisor creates a separate Git worktree and branch; it does not run experiments directly in the original checkout.

When no model is supplied, the add-on reads child `pi --list-models` and posts a model-picker Adaptive Card before starting.

### `autoresearch_status`

Reads current tmux/session state and recent JSONL experiment results.

### `stop_autoresearch`

Stops the tmux session and produces a Markdown report when experiment data is available.

## Runtime UI

The add-on registers an `autoresearch` status panel, posts experiment updates to the originating chat, and handles launch/stop card intents.

## Skill

The bundled `autoresearch-create` skill describes the inner experiment files and loop used by the child agent.
