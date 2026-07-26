# Stealth Browser

Human-like browser automation backed by `@mochi.js/core`. Requires Piclaw `>=2.0.0`.

## Install

Open **Settings → Add-Ons** and install **stealth-browser** from the catalog. Install a compatible Chromium build before first use:

```bash
bunx @mochi.js/cli browsers install
```

## Tool

`stealth_browser` manages its own Chromium process. Actions include:

- `goto`, `click`, `type`, and `scroll`
- `text`, `evaluate`, and `screenshot`
- Chrome-stack `fetch`
- cookie save/load/list
- `status` and `close`

A session is reused across calls. The add-on checks for five minutes of inactivity about five minutes after session creation; activity does not reset or reschedule that check. `close` and extension unload always stop Chromium. Text and fetch responses are capped at 30,000 characters. Screenshots default to `/workspace/tmp/stealth-screenshot.png`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PICLAW_STEALTH_SEED` | Stable fingerprint seed | hostname |
| `PICLAW_STEALTH_PROFILE` | Explicit Mochi profile | auto-detected |
| `PICLAW_STEALTH_PROXY` | Proxy URL | none |
| `PICLAW_STEALTH_HEADLESS` | Headless mode | `true` |

## Skill

The bundled `stealth-browse` skill explains when to prefer this managed browser over `cdp_browser`.
