# Smart Compaction Add-on

> ⚠️ **For vanilla `pi` users.** Piclaw already includes smart compaction natively. If this package is loaded inside Piclaw it disables itself by default to avoid duplicate compaction handlers.

This is a standalone, code-complete Pi extension package that ports Piclaw's selective smart-compaction behavior into a vanilla `pi` add-on. It does **not** import Piclaw runtime internals and does **not** move or replace Piclaw's built-in implementation.

## What it does

- Hooks `session_before_compact` and returns a custom compaction result.
- Selects high-signal conversation fragments instead of summarizing the full transcript blindly.
- Preserves current/kept-window context so summaries do not over-focus on stale work.
- Detects recent topic shifts and demotes older topics to background context.
- Uses no-op mechanical compaction for safe split-turn/minimal-content cases.
- Uses progressive chunk/merge compaction when the prompt is too large for the active model.
- Adds deterministic `<read-files>` and `<modified-files>` sections.
- Uses Pi's standard working-status feedback only; it does not create extra notification/message panes.

## Install

From a local checkout:

```bash
pi install /workspace/piclaw-addons/addons/smart-compaction
```

Or run temporarily:

```bash
pi -e /workspace/piclaw-addons/addons/smart-compaction
```

## Piclaw behavior

This package is meant for users running upstream/vanilla `pi`. In Piclaw, the equivalent extension is already built in. To avoid registering two compaction handlers, this add-on checks for Piclaw runtime environment variables and stays inert unless explicitly forced:

```bash
PI_SMART_COMPACTION_ALLOW_PICLAW=1 pi -e /path/to/smart-compaction
```

Use that override only for local testing.

## Configuration

Optional environment variables:

| Variable | Purpose |
| --- | --- |
| `PI_SMART_COMPACTION_DEBUG=1` | Log debug details to stderr/console. |
| `PI_SMART_COMPACTION_SYSTEM_PROMPT_OVERHEAD_TOKENS` | Override estimated non-message prompt/tool overhead. |
| `PI_SMART_COMPACTION_PROGRESSIVE=1` | Force progressive chunk/merge compaction. |
| `PI_SMART_COMPACTION_PROGRESSIVE_PROMPT_CHARS` | Override the single-pass prompt character budget before progressive mode. |

Historical `PICLAW_*` equivalents are accepted for copied local configurations, but `PI_SMART_COMPACTION_*` is preferred for vanilla `pi`.

## Notes

The extension uses the active session model and public Pi/Pi-AI APIs:

- `session_before_compact`
- `ctx.modelRegistry.getApiKeyAndHeaders(model)`
- `completeSimple`

Message/file serialization is bundled locally so no Piclaw source imports are required at runtime.
