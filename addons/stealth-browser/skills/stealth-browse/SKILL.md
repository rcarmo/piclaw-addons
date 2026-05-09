---
name: stealth-browse
description: Use the stealth browser for human-like web automation against bot-protected sites. Handles login flows, scraping, and form filling with anti-detection bypass.
---

# Stealth Browse

Use the `stealth_browser` tool for web automation that requires anti-bot bypass or human-like interaction fidelity.

## When to use this over cdp_browser

| Scenario | Use |
|---|---|
| Control a browser the user already opened | `cdp_browser` |
| Automate a site with Cloudflare/Turnstile protection | `stealth_browser` |
| Screenshot an internal tool page | `cdp_browser` |
| Log into a web service, scrape content | `stealth_browser` |
| Export a page to PDF | `cdp_browser` |
| Fill forms with human-like delays and mouse movement | `stealth_browser` |

## Session lifecycle

A session persists across tool calls within a turn. The first `goto` call launches a headless Chromium; subsequent calls reuse it. The session auto-closes after 5 minutes of inactivity or when the turn ends.

## Actions

### Navigation
```
stealth_browser action=goto url="https://example.com"
```

### Interaction (human-like)
```
stealth_browser action=click selector="#login-button"
stealth_browser action=type selector="#email" text="user@example.com"
stealth_browser action=scroll to="bottom"
```

### Content extraction
```
stealth_browser action=text selector="article"
stealth_browser action=evaluate expr="document.querySelectorAll('.item').length"
stealth_browser action=screenshot fullPage=true outPath="/workspace/tmp/page.png"
```

### Network (through Chrome TLS stack)
```
stealth_browser action=fetch url="https://api.example.com/data" method="GET"
```

### Session management
```
stealth_browser action=cookies save="/workspace/tmp/cookies.json"
stealth_browser action=cookies load="/workspace/tmp/cookies.json"
stealth_browser action=status
stealth_browser action=close
```

## Configuration

Set via environment variables or the add-on settings pane:

| Variable | Description | Default |
|---|---|---|
| `PICLAW_STEALTH_SEED` | Fingerprint seed (identity stability) | hostname |
| `PICLAW_STEALTH_PROFILE` | Profile ID override | auto-detected per OS |
| `PICLAW_STEALTH_PROXY` | Proxy URL (`http://user:pass@host:port`) | none |
| `PICLAW_STEALTH_HEADLESS` | Headless mode (`true`/`false`) | `true` |

## Prerequisites

Chromium must be installed. On first use:
```bash
bunx @mochi.js/cli browsers install
```

## Key constraints (from mochi API)

- No `page.click()` — always `humanClick` (realistic trajectory)
- No per-surface fingerprint randomization — one (profile, seed) pair determines everything
- `evaluate` takes zero-arg functions only — return JSON-serializable values
- One session per Chromium process — no shared contexts
