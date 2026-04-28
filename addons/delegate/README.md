# Delegate

Send tasks to a cheaper/faster model in a fresh context with auto model selection, tool access, and MCP support.

## Features

- **Auto model selection** — picks the best model for the task category, never exceeding the current model's tier
- **6 task categories** — quick, summarize, code, analyze, reason, judge
- **Tool access** — delegate has read, grep, find, ls, bash, MCP tools by default
- **MCP support** — any servers in `.pi/mcp.json` are available
- **Multimodal** — images/PDFs passed as native attachments with automatic tier bumping
- **Judge mode** — cross-family second opinion for reviewing agent responses
- **Skills** — all `.pi/skills/` auto-discovered (web-search, etc.)
- **Fresh context** — no conversation history, saves tokens

## Install

Open **Settings → Add-Ons** and install **delegate** from the catalog.

Then restart PiClaw. The extension auto-activates itself.

### Optional: config-based activation

You can also add delegate to the default active tools in `.piclaw/config.json`:

```json
{
  "tools": {
    "additionalDefaultTools": ["delegate"]
  }
}
```

## Stress test results

Tested on 12-core / 7.5GB container (github-copilot provider):

| Concurrency | Success rate | Avg latency | Max latency | Memory delta |
|---|---|---|---|---|
| 1 | 100% | 3.6s | 3.6s | — |
| 5 | 100% | 2.4s | 3.1s | — |
| 10 | 100% | 2.5s | 3.0s | +7 MB |
| 20 | 100% | 3.3s | 5.6s | +3 MB |
| 30 | 100% | 3.8s | 4.6s | +14 MB |

Safe for up to 20 concurrent calls. Bottleneck is API rate limits, not local resources.

### Running the stress test

```bash
# Phase 1: basic concurrency (1, 2, 3, 5, 8, 10)
bun tests/delegate-stress-test.ts

# Phase 2: higher load + memory monitoring (10, 15, 20, 25, 30)
bun tests/delegate-stress-test-2.ts
```

This is redundant if using the extension (it self-activates), but useful if you want explicit config control.

## Quick reference

| Category | Model picked | Use for |
|---|---|---|
| `quick` | gpt-5.4-mini (tier 2) | Formatting, factual Q&A, translation |
| `summarize` | gpt-5.4-mini (tier 2) | File/note/code summaries |
| `code` | claude-sonnet-4.6 (tier 3) | Code gen, refactoring |
| `analyze` | claude-sonnet-4.6 (tier 3) | Code review, debugging |
| `reason` | claude-sonnet-4.6 (tier 3) | Complex logic — if you need frontier, don't delegate |
| `judge` | Different family than current (tier 3) | Second opinion, verify, double check |

| Tool profile | Tools included |
|---|---|
| `read_only` | read, grep, find, ls, mcp |
| `standard` (default) | read, grep, find, ls, bash, mcp |
| `full` | read, grep, find, ls, bash, edit, write, mcp |
