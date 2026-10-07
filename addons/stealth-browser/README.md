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

A session is reused across calls. Idle checks reschedule after activity; an attached CDP viewer keeps the session alive. `close` and extension unload stop Chromium.

On cores with the shared CDP viewer, **Open browser in tab** displays the existing Stealth Browser. It is view-only until you take control; tool actions refuse execution until you release control. Scale-to-fit preserves the viewport. Optional resizing changes page layout and may affect fingerprint consistency; releasing control restores the native viewport. Closing the pane detaches the viewer without closing Chromium. Mochi 0.9.5 retains its pipe transport; the viewer attaches to a verified loopback endpoint on that same browser. Text and fetch responses are capped at 30,000 characters. Screenshots default to `/workspace/tmp/stealth-screenshot.png`.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `PICLAW_STEALTH_SEED` | Stable fingerprint seed | hostname |
| `PICLAW_STEALTH_PROFILE` | Explicit Mochi profile | auto-detected |
| `PICLAW_STEALTH_PROXY` | Proxy URL | none |
| `PICLAW_STEALTH_HEADLESS` | Headless mode | `true` |

## Skill

The bundled `stealth-browse` skill explains when to prefer this managed browser over `cdp_browser`.
