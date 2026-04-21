# Install piclaw-addons

Install extensions and scripts from [rcarmo/piclaw-addons](https://github.com/rcarmo/piclaw-addons) into the current workspace.

## Usage

Run from the PiClaw agent:

```bash
bash /workspace/.pi/skills/install-addons/install-addons.sh
```

Or ask the agent: *"install addons from piclaw-addons"*

## What it does

1. Clones `rcarmo/piclaw-addons` to a temp directory
2. Copies extensions to `.pi/extensions/`
3. Copies scripts to `scripts/`
4. Cleans up temp files
5. Agent should restart (`exit_process`) to load new extensions
