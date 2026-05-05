# @rcarmo/piclaw-addon-goal

Session-scoped goal seeking for piclaw.

Inspired by the `/goal` loop described in Simon Willison’s write-up of Codex CLI 0.128.0, this add-on lets a chat keep working toward a saved objective until it is completed, paused, or the configured token budget is exhausted.

## Install

Open **Settings → Add-Ons** and install **goal** from the catalog.

## What it does

- adds a **Goal** settings pane
- stores editable goal prompt templates in extension KV
- stores a per-chat goal state (objective, enabled flag, token budget, usage, latest progress phase)
- adds `/goal` commands for starting, resuming, pausing, clearing, and inspecting a goal run
- auto-continues the active goal after each turn while goal seeking is enabled
- posts visible `goal-status` timeline updates when a run starts, resumes, continues, reaches its budget, or completes
- updates the standard Pi progress UI live with phase labels and a Braille glyph bar showing remaining tokens for the run
- restores an active web progress strip from saved state after page refreshes, tab visibility changes, and chat tab returns
- provides an internal `update_goal` tool so the model can mark a goal complete after verification

## `/goal` command

- `/goal` — post help text and current goal state to the timeline
- `/goal <objective>` — start or replace the active goal run in the current chat
- `/goal status` — show the current goal state
- `/goal on` or `/goal resume` — resume the saved objective
- `/goal off` — pause goal seeking in this chat
- `/goal clear` — clear the saved goal state

## Settings pane

Open **Settings → Goal** to:

- turn goal seeking on or off for the current chat session
- edit the saved objective and token budget for the current chat
- edit the global prompt templates used for goal seeking
- review current token usage and remaining budget

### Prompt placeholders

The editable prompt templates support these placeholders:

- `{{ objective }}`
- `{{ time_used_seconds }}`
- `{{ tokens_used }}`
- `{{ token_budget }}`
- `{{ remaining_tokens }}`
- `{{ status }}`
- `{{ chat_jid }}`
- `{{ completion_summary }}`

## Storage model

| What | Where |
|---|---|
| Global prompt templates | Extension KV (`goal`, global scope) |
| Default token budget | Extension KV (`goal`, global scope) |
| Per-chat goal state and latest progress phase | Extension KV (`goal`, chat scope) |

## Notes

- Goal seeking is scoped to the current chat/session, not globally across all chats.
- The add-on uses a token-budget heuristic based on assistant message usage.
- Goal execution emits durable timeline status messages in addition to transient native Pi progress updates.
- The native Pi progress indicator uses a Braille token-availability bar, e.g. `[⣿⣿⣦⣀]`, where filled cells are remaining budget; visible token counts use friendly units such as `20k` or `1.25m`.
- Live progress phases include starting, waiting for model, working, receiving response, tool use, usage updated, continuing, budget-limited, and complete.
- The web progress bridge polls saved goal state while the page is open, so active goal progress reappears after refreshes or returning to a chat tab without adding timeline messages.
- When the objective is truly done, the model should call `update_goal` with status `complete`.
