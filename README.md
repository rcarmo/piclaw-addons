# piclaw-addons

Community extensions and add-ons for [piclaw](https://github.com/rcarmo/piclaw). Browse the full catalog at **[rcarmo.github.io/piclaw-addons](https://rcarmo.github.io/piclaw-addons/)**.

> **For agents:** see [AGENTS.md](AGENTS.md) for how to add, modify, and test addons.

---

## Installing add-ons

> **Important:** first-party `piclaw-addons` installs must use **public GitHub-hosted tarball URLs**.
> Do **not** switch examples, catalog entries, or runtime code to npmjs.org package specs or authenticated GitHub Packages reads.
> Runtime install/remove must work with zero registry auth.

### Web UI (recommended)

Open **Settings → Add-Ons**, pick an add-on, click **Install**. Restart required.

### `pi install`

```bash
pi install https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-proxmox-0.1.3.tgz
```

### `bun add`

```bash
cd /workspace/.pi/extensions
bun add https://rcarmo.github.io/piclaw-addons/packages/piclaw-addon-proxmox-0.1.3.tgz
```

---

## Available add-ons

| Add-on | Description |
|---|---|
| [`autoresearch`](addons/autoresearch/) | Autonomous experiment loop sub-agent |
| [`cheapskate`](addons/cheapskate/) | Free-tier provider auto-rotation (`cheapskate/auto` model) |
| [`code-validator`](addons/code-validator/) | Code validation for Python, JS/TS, JSON |
| [`delegate`](addons/delegate/) | Task delegation to cheaper/faster models |
| [`dev-tools`](addons/dev-tools/) | Workspace diagnostics and environment tools |
| [`drawio-editor`](addons/drawio-editor/) | Self-hosted draw.io diagram editor |
| [`eml-viewer`](addons/eml-viewer/) | Email (.eml) viewer for the web timeline |
| [`imap`](addons/imap/) | IMAP email management with drafts and STARTTLS |
| [`kanban-board-widget`](addons/kanban-board-widget/) | Kanban board dashboard widget |
| [`portainer`](addons/portainer/) | Portainer container management |
| [`proxmox`](addons/proxmox/) | Proxmox VE infrastructure management |
| [`voice-pipeline`](addons/voice-pipeline/) | ESPHome voice assistant for ThinkSmart/ESP32 |
| [`yolochat`](addons/yolochat/) | Zero-guardrail inter-instance messaging |

---

## Publishing workflow

![Event sequence](assets/event-sequence.svg)

A push to any `addons/<slug>/` path triggers the full chain:

1. **sync-catalog** — regenerates `catalog.json` with **public tarball URLs** from addon `package.json` files
2. **build + deploy** — rebuilds the docs site and deploys the downloadable `.tgz` files to GitHub Pages
3. **publish** — optionally mirrors version-bumped packages to GitHub Packages for archival/alternate consumption

The supported first-party runtime install path is the **GitHub Pages tarball URL**, not npm registry resolution.

---

## Contributing

See [AGENTS.md](AGENTS.md) for how to add a new addon, run the metadata checks, and test locally.
